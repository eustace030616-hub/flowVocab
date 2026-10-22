/**
 * Folding the event log into a per-language ability estimate.
 *
 * Two rules, both inherited from the design this replaces being wrong in the same two ways:
 *
 *   1. Per target language, always. The old model kept one `levelScore` with no language dimension,
 *      so adding German would have shared one level between two languages.
 *
 *   2. Transfer is a *prior*, never the estimate. Track 2 presumes its user already reads English,
 *      so `θ_en` is a legitimate starting point for `θ_de` — but it only ever centres the fit. The
 *      German evidence has to be able to move it, and with enough of it the prior stops mattering.
 */

import {
  abilityFor,
  abilitiesFor as abilitiesForStore,
  latestCompletedPlacement,
  upsertAbility,
} from "../store/learner";
import type { CefrLevel, TargetLang } from "../lang";
import {
  fitAbility,
  LEVEL_SE_THRESHOLD,
  type AbilityEstimate,
} from "./ability";
import { observationsFor } from "./ability-store";
import { levelFromDifficulty } from "../difficulty";
import { placementObservations } from "./placement";

/** Collapse a fully uncertain estimate to a single point, so it cannot masquerade as a range. */
function levelAtTheta(theta: number): NonNullable<AbilityEstimate["level"]> {
  const level = levelFromDifficulty(Math.min(1, Math.max(0, theta)));
  if (!level) throw new Error(`no CEFR level for ability ${theta}`);
  return level;
}

/** Languages that can lend a prior. English informs German, because track 2 assumes English. */
const PRIOR_SOURCE: Partial<Record<TargetLang, TargetLang>> = { de: "en" };

/**
 * How strongly a transferred estimate is felt, in observations.
 *
 * Two is a nudge: a handful of real German observations outweigh it. This is the number that
 * decides whether an English speaker starts German at "somewhere sensible" or at exactly their
 * English level, and the evidence should win quickly.
 */
const TRANSFER_PRIOR_WEIGHT = 2;

/**
 * The prior every estimate carries, so a handful of observations cannot swing it.
 *
 * Marking two words you did not know says very little about your level — you may know ten thousand
 * others — but with no prior at all the fit has nothing to weigh them against, and two marks at low
 * difficulty pulled ability to the floor. That is not a measurement, it is an overreaction to two
 * clicks, and it then propagates: the next paragraph's coverage is computed from whatever ability
 * the marks left behind.
 *
 * Two observations' worth at the midpoint is enough to hold the estimate steady while evidence
 * accumulates, and negligible once there is real evidence — a 67-item placement outweighs it by an
 * order of magnitude.
 */
const REGULARISER_WEIGHT = 2;
const MIDPOINT_THETA = 0.5;

export interface AbilityView extends AbilityEstimate {
  /**
   * The level at θ, always. `level` is the *claimable* one and stays null until the interval is
   * narrow — which is correct and also why the header looked frozen: marking a few words moves θ
   * every time, but with eight observations the interval is still three bands wide, so no label ever
   * appeared. The point estimate is what makes the movement visible, and it is shown as an estimate
   * with its interval beside it rather than as a measurement.
   */
  levelPoint: CefrLevel;
  targetLang: TargetLang;
  /** True when the estimate was centred by another language, with no evidence of its own. */
  fromTransfer: boolean;
}

function toView(targetLang: TargetLang, estimate: AbilityEstimate, fromTransfer: boolean): AbilityView {
  return { ...estimate, targetLang, fromTransfer, levelPoint: levelAtTheta(estimate.theta) };
}

/**
 * Recompute and cache the estimate for one learner and language.
 *
 * Returns the fresh estimate so a caller can hand it straight back to the client rather than
 * reading back what it just wrote.
 */
export async function recomputeAbility(
  userId: string,
  targetLang: TargetLang,
): Promise<AbilityView> {
  const observations = await observationsFor(userId, targetLang);

  // The placement test is evidence like any other, folded into the same fit — its observations carry
  // the test's own false-alarm rate as a guessing floor, so a learner who claims pseudowords is
  // corrected rather than believed. This is why the cold start is a measurement and not a guess.
  const placement = latestCompletedPlacement(userId, targetLang);

  // A completed session carries both the item set and the answers, so the evidence is exact rather
  // than reconstructed from a summary.
  const withPlacement =
    placement?.items?.length && placement.responses?.length
      ? [
          ...observations,
          ...placementObservations(
            placement.items as Parameters<typeof placementObservations>[0],
            placement.responses as Parameters<typeof placementObservations>[1],
          ),
        ]
      : observations;

  // A prior is only needed when the language has little to say for itself. Once there is real
  // evidence — including a placement test — another language's level is a distraction rather than a
  // starting point.
  // Every estimate carries the neutral regulariser; a transfer replaces it when one is available
  // and the language has little to say for itself.
  let prior: { theta: number; weight: number } = {
    theta: MIDPOINT_THETA,
    weight: REGULARISER_WEIGHT,
  };
  let transferred = false;

  if (withPlacement.length < TRANSFER_PRIOR_WEIGHT) {
    const source = PRIOR_SOURCE[targetLang];
    if (source) {
      const donor = abilityFor(userId, source);
      // Only a donor that is itself reasonably certain is worth borrowing from. Transferring a
      // degenerate estimate — every word "known", interval the whole scale — just spreads one
      // unreliable number into a second language.
      if (donor && donor.n > 0 && donor.se <= LEVEL_SE_THRESHOLD * 2) {
        prior = { theta: donor.theta, weight: TRANSFER_PRIOR_WEIGHT };
        transferred = true;
      }
    }
  }

  const estimate = fitAbility(withPlacement, prior);

  upsertAbility(userId, {
    targetLang,
    theta: estimate.theta,
    se: estimate.se,
    n: estimate.n,
    level: estimate.level,
    levelLow: estimate.levelLow,
    levelHigh: estimate.levelHigh,
    // Only a borrowed centre is recorded as such; the neutral regulariser is not a claim.
    priorTheta: transferred ? prior.theta : null,
  });

  // With a prior and no evidence of its own, the estimate is another language's number wearing
  // this language's name. It may say where to start; it may not report a range as though this
  // language had been measured.
  //
  // With no prior either, the estimate is simply unknown — and then the wide interval from the fit
  // is the honest answer. Collapsing that to a point printed a confident "B2" for a learner who had
  // done nothing at all.
  const view =
    estimate.n === 0 && transferred
      ? {
          ...estimate,
          level: null,
          levelLow: levelAtTheta(estimate.theta),
          levelHigh: levelAtTheta(estimate.theta),
        }
      : estimate;

  return toView(targetLang, view, transferred && estimate.n === 0);
}

/**
 * Every estimate for a learner, for the interface to show.
 *
 * Missing languages are computed rather than omitted, so a new learner sees both tracks as
 * "not measured yet" instead of one blank row.
 */
export async function abilitiesFor(userId: string): Promise<AbilityView[]> {
  const langs: TargetLang[] = ["en", "de"];
  let rows = abilitiesForStore(userId);
  if (rows.length < langs.length) {
    await recomputeAllAbilities(userId);
    rows = abilitiesForStore(userId);
  }

  return rows.map((row) =>
    toView(
      row.targetLang as TargetLang,
      {
        theta: row.theta,
        se: row.se,
        n: row.n,
        level: (row.level ?? null) as CefrLevel | null,
        levelLow: row.levelLow as CefrLevel,
        levelHigh: row.levelHigh as CefrLevel,
      },
      row.n === 0 && row.priorTheta !== null,
    ),
  );
}

/**
 * Recompute both languages for one learner.
 *
 * Called after events are appended. Both, not just the affected one: an event in English can change
 * the prior that German is using, and a stale prior is worse than a recomputed one.
 */
export async function recomputeAllAbilities(userId: string): Promise<AbilityView[]> {
  const views: AbilityView[] = [];
  // Sequential on purpose. German's prior is English's estimate, so computing them concurrently let
  // German read whichever English row happened to be there — a race that made the starting point
  // depend on timing.
  for (const lang of ["en", "de"] as TargetLang[]) {
    views.push(await recomputeAbility(userId, lang));
  }
  return views;
}
