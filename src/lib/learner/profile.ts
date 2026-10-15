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

import { AbilityState } from "../../models/AbilityState";
import type { TargetLang } from "../lang";
import {
  fitAbility,
  observationsFor,
  LEVEL_SE_THRESHOLD,
  type AbilityEstimate,
} from "./ability";
import { levelFromDifficulty } from "../difficulty";

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

export interface AbilityView extends AbilityEstimate {
  targetLang: TargetLang;
  /** True when the estimate was centred by another language, with no evidence of its own. */
  fromTransfer: boolean;
}

function toView(targetLang: TargetLang, estimate: AbilityEstimate, fromTransfer: boolean): AbilityView {
  return { ...estimate, targetLang, fromTransfer };
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

  // A prior is only needed when the language has little to say for itself. Once there is real
  // evidence, another language's level is a distraction rather than a starting point.
  let prior: { theta: number; weight: number } | undefined;
  let fromTransfer = false;

  if (observations.length < TRANSFER_PRIOR_WEIGHT) {
    const source = PRIOR_SOURCE[targetLang];
    if (source) {
      const donor = await AbilityState.findOne({ userId, targetLang: source }).lean();
      // Only a donor that is itself reasonably certain is worth borrowing from. Transferring a
      // degenerate estimate — every word "known", interval the whole scale — just spreads one
      // unreliable number into a second language.
      if (donor && donor.n > 0 && donor.se <= LEVEL_SE_THRESHOLD * 2) {
        prior = { theta: donor.theta, weight: TRANSFER_PRIOR_WEIGHT };
        fromTransfer = observations.length === 0;
      }
    }
  }

  const estimate = fitAbility(observations, prior);

  await AbilityState.updateOne(
    { userId, targetLang },
    {
      $set: {
        theta: estimate.theta,
        se: estimate.se,
        n: estimate.n,
        level: estimate.level,
        levelLow: estimate.levelLow,
        levelHigh: estimate.levelHigh,
        priorTheta: prior?.theta ?? null,
      },
    },
    { upsert: true },
  );

  // With a prior and no evidence of its own, the estimate is another language's number wearing
  // this language's name. It may say where to start; it may not report a range as though this
  // language had been measured.
  //
  // With no prior either, the estimate is simply unknown — and then the wide interval from the fit
  // is the honest answer. Collapsing that to a point printed a confident "B2" for a learner who had
  // done nothing at all.
  const view =
    estimate.n === 0 && prior
      ? {
          ...estimate,
          level: null,
          levelLow: levelAtTheta(estimate.theta),
          levelHigh: levelAtTheta(estimate.theta),
        }
      : estimate;

  return toView(targetLang, view, fromTransfer);
}

/**
 * Every estimate for a learner, for the interface to show.
 *
 * Missing languages are computed rather than omitted, so a new learner sees both tracks as
 * "not measured yet" instead of one blank row.
 */
export async function abilitiesFor(userId: string): Promise<AbilityView[]> {
  const langs: TargetLang[] = ["en", "de"];
  let rows = await AbilityState.find({ userId }).sort({ targetLang: 1 }).lean();
  if (rows.length < langs.length) {
    await recomputeAllAbilities(userId);
    rows = await AbilityState.find({ userId }).sort({ targetLang: 1 }).lean();
  }

  return rows.map((row) =>
    toView(
      row.targetLang,
      {
        theta: row.theta,
        se: row.se,
        n: row.n,
        level: row.level ?? null,
        levelLow: row.levelLow,
        levelHigh: row.levelHigh,
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
