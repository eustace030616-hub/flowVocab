/**
 * Learner ability, estimated on the item-difficulty axis.
 *
 * ## Why this axis
 *
 * Item difficulty is a number in `[0, 1]` derived from frequency (see lib/difficulty.ts), and a
 * CEFR label is a *label on that number*, not a separate quantity. Putting ability on the same axis
 * means:
 *
 *   - "θ = 0.42" and "item difficulty = 0.42" are directly comparable: the learner is about 50/50
 *     on items of that difficulty. No conversion, no lookup table.
 *   - the CEFR label for θ is `levelFromDifficulty(θ)`, the same calibration the items use. A level
 *     cannot drift out of step with the items it describes, because there is only one scale.
 *   - the standard error maps to a *level range* rather than a bare label, so an estimate that is
 *     not yet trustworthy says so instead of claiming B2 from four answers.
 *
 * ## Why a fit and not a running counter
 *
 * The logic this replaces (`levelService.js`) added a fixed number of points per correct answer and
 * only ever increased. Ability has to be able to fall, and it has to be recomputable from the log:
 * this is a maximum-likelihood Rasch fit over the evidence, so folding the same log twice gives the
 * same answer, and a bug or a bad import is repairable rather than permanent.
 *
 * Pure — no database, no clock — so the estimator is tested directly.
 */

import { levelFromDifficulty } from "../difficulty";
import type { CefrLevel } from "../lang";
import { Event } from "../../models/Event";
import { Word } from "../../models/Word";
import { EVIDENCE_WINDOW_MS, MAX_EVENTS_FOLDED } from "./known";

/** Slope of the logistic. A 0.15 difficulty gap is roughly 73% expected success. */
export const ABILITY_SCALE = 0.15;

/** Ability is clamped inside the open interval; a probability of exactly 0 or 1 is never claimed. */
const THETA_FLOOR = 0.01;
const THETA_CEILING = 0.99;

/**
 * Standard error below which a single CEFR label is claimed.
 *
 * Above it the estimate is still reported, as a range. The number is set so that a label needs
 * roughly a dozen informative observations: claiming a level from three words is how a placement
 * test becomes a guess with a confident font.
 */
export const LEVEL_SE_THRESHOLD = 0.05;

/**
 * Separate reading sessions in which a word must be met, without a lookup, before that counts as
 * evidence of knowing it.
 *
 * Counting raw occurrences does not work, and the measurement showed it: reading one paragraph four
 * times gave every word four exposures, and the estimate went to C1/C2 — because the model read
 * "was on screen four times in one minute" as knowledge. Repetition inside a single sitting is not
 * evidence; meeting the same word again on another day, and still not needing to look it up, is.
 *
 * So exposures are counted per session, never per view.
 */
export const SESSIONS_FOR_KNOWN = 3;

export interface Observation {
  /** Item difficulty in the same units as θ. */
  difficulty: number;
  /** Whether the accumulated evidence says the learner knows this item. */
  known: boolean;
  /** Strength of that evidence; a confirmed answer outranks a single exposure. */
  weight: number;
  /**
   * False-alarm rate for this observation's response curve, if it came from a test where "yes" is
   * cheap.
   *
   * Per observation rather than per fit, because the two kinds of evidence have different curves: a
   * placement answer can be a lucky claim, while "read past it without looking it up" cannot. One
   * floor for the whole fit would correct the reading evidence for guessing that never happened.
   */
  guessing?: number;
}

export interface AbilityPrior {
  /** Where to centre a weak prior, typically another language's estimate. */
  theta: number;
  /** How many observations the prior is worth. Two is a nudge; ten is an opinion. */
  weight: number;
}

export interface FitOptions {
  prior?: AbilityPrior;
  /**
   * False-alarm rate to correct for, in [0, 1).
   *
   * A test where "yes" is cheap scores lucky claims as knowledge; the floor keeps them from being
   * counted as ability. Zero for evidence that has no guessing, such as reading behaviour.
   */
  guessing?: number;
}

export interface AbilityEstimate {
  /** Ability on the item-difficulty axis. */
  theta: number;
  /** Standard error of θ, same units. */
  se: number;
  /** Effective number of observations behind the estimate. */
  n: number;
  /** Level for θ alone, when the interval is narrow enough to claim one. */
  level: CefrLevel | null;
  /** Level range implied by the confidence interval — always reportable. */
  levelLow: CefrLevel;
  levelHigh: CefrLevel;
}

/**
 * The level for a point on the ability axis.
 *
 * `levelFromDifficulty` returns null only for a value below zero, which a clamped θ cannot be; the
 * assertions here are for the type system, and a wrong value would be a bug rather than a case to
 * handle quietly.
 */
function levelAt(theta: number): CefrLevel {
  const level = levelFromDifficulty(Math.min(1, Math.max(0, theta)));
  if (!level) throw new Error(`no CEFR level for ability ${theta}`);
  return level;
}

/** Probability the learner knows an item of this difficulty. */
export function probabilityKnown(theta: number, difficulty: number): number {
  return 1 / (1 + Math.exp(-(theta - difficulty) / ABILITY_SCALE));
}

/**
 * Probability of answering "yes" to an item of this difficulty.
 *
 * A yes/no test lets a learner who does not know a word claim it anyway, so the response curve has
 * a floor at the false-alarm rate. On a three-option quiz that floor would be ~1/3; here it is
 * measured from the learner's own responses to the pseudowords in the same test, which is why the
 * placement test carries them.
 */
export function probabilityYes(theta: number, difficulty: number, guessing = 0): number {
  const p = probabilityKnown(theta, difficulty);
  return guessing + (1 - guessing) * p;
}

/**
 * Fit ability by maximum likelihood (Rasch, one parameter) with Newton-Raphson.
 *
 * A weak prior keeps the estimate finite when the evidence is one-sided — a learner who knows every
 * word they have met has no upper bound in the likelihood alone. The prior is applied as two
 * opposed pseudo-observations at its centre, which pulls toward it without favouring up or down.
 */
export function fitAbility(
  observations: Observation[],
  options: AbilityPrior | FitOptions = {},
): AbilityEstimate {
  // Accept a bare prior, which is what every existing call site passes.
  const asPrior = "theta" in options ? (options as AbilityPrior) : (options as FitOptions).prior;
  // The floor may reach 1: a learner who claims every pseudoword has told us nothing, and the fit
  // has to be able to say so. Capping it below 1 let the residual sliver of discrimination be read
  // as high ability, which is the opposite of the truth.
  const guessing = "theta" in options ? 0 : Math.min(1, Math.max(0, (options as FitOptions).guessing ?? 0));
  const prior = asPrior;
  const usable = observations.filter(
    (o) => Number.isFinite(o.difficulty) && o.weight > 0,
  );

  const weighted = [...usable];
  if (prior && prior.weight > 0) {
    const half = prior.weight / 2;
    weighted.push(
      { difficulty: prior.theta, known: true, weight: half, guessing: 0 },
      { difficulty: prior.theta, known: false, weight: half, guessing: 0 },
    );
  }

  const totalWeight = weighted.reduce((sum, o) => sum + o.weight, 0);
  if (totalWeight === 0) {
    // No evidence at all. The honest answer is the widest interval, not a point: collapsing this to
    // a single level printed a confident "B2" for a learner who had done nothing.
    const centre = prior?.theta ?? 0.5;
    const se = ABILITY_SCALE * 4;
    return {
      theta: centre,
      se,
      n: 0,
      level: null,
      levelLow: levelAt(Math.max(THETA_FLOOR, centre - 1.96 * se)),
      levelHigh: levelAt(Math.min(THETA_CEILING, centre + 1.96 * se)),
    };
  }

  // Start at the weighted mean of the observed difficulties: a stable place to iterate from, and
  // already the right answer when the evidence is symmetric.
  let theta =
    weighted.reduce((sum, o) => sum + o.difficulty * o.weight, 0) / totalWeight;
  theta = Math.min(THETA_CEILING, Math.max(THETA_FLOOR, theta));

  for (let iteration = 0; iteration < 50; iteration += 1) {
    let gradient = 0;
    let curvature = 0;
    for (const o of weighted) {
      // With a floor, the observed curve is `g + (1-g)·logistic`, so both the residual and the
      // slope carry the (1-g) factor. Skipping it would fit a curve the responses never followed.
      const floor = o.guessing ?? guessing;
      const p = probabilityYes(theta, o.difficulty, floor);
      const y = o.known ? 1 : 0;
      gradient += o.weight * (y - p);
      curvature += o.weight * (1 - floor) * p * (1 - p);
    }
    if (curvature < 1e-9) break;

    // Newton on the log-likelihood gives a step in log-odds; dividing by the slope converts it to
    // the difficulty axis. Omitting the scale factor overshoots by 1/0.15 and the fit oscillates.
    const step = (ABILITY_SCALE * gradient) / curvature;
    const next = Math.min(THETA_CEILING, Math.max(THETA_FLOOR, theta + step));
    const converged = Math.abs(next - theta) < 1e-7;
    theta = next;
    if (converged) break;
  }

  let information = 0;
  for (const o of weighted) {
    const floor = o.guessing ?? guessing;
    const p = probabilityYes(theta, o.difficulty, floor);
    information += o.weight * (1 - floor) * p * (1 - p);
  }
  // Fisher information for the logistic slope: se = scale / sqrt(information).
  const se = information > 0 ? ABILITY_SCALE / Math.sqrt(information) : ABILITY_SCALE * 4;

  // The effective count is the evidence in "one observation" units, so the prior does not inflate
  // how much the learner has actually shown.
  const n = usable.reduce((sum, o) => sum + o.weight, 0);

  const low = Math.max(THETA_FLOOR, theta - 1.96 * se);
  const high = Math.min(THETA_CEILING, theta + 1.96 * se);

  return {
    theta,
    se,
    n,
    level: se <= LEVEL_SE_THRESHOLD && n >= 1 ? levelAt(theta) : null,
    levelLow: levelAt(low),
    levelHigh: levelAt(high),
  };
}

/** Whether an estimate is solid enough to show as a single level. */
export function isLevelClaimable(estimate: Pick<AbilityEstimate, "se" | "n">): boolean {
  return estimate.se <= LEVEL_SE_THRESHOLD && estimate.n >= 1;
}

/** Evidence weights. Named, because the relative sizes are the model's real content. */
export const EVIDENCE_WEIGHT = {
  /** An explicit "I know this" after review. The strongest and rarest signal. */
  confirmed: 1.5,
  /** "Not sure" but answered — modelled as evidence, not as a plain wrong answer. */
  notSure: 1,
  /** The learner marked the word as unknown. A deliberate statement about themselves. */
  mark: 0.5,
  /** The learner opened the word. Weak and biased, but real. */
  lookup: 0.5,
  /** One exposure, once the word has been met enough times for it to count. */
  exposure: 0.25,
} as const;

/**
 * Most exposure credit one word can earn, in exposure units.
 *
 * Exposure repeats help, but with sharply diminishing force: a word met twenty times is not ten
 * times as known as one met three times, and unbounded credit would let a long paragraph outweigh
 * a term's worth of answered questions.
 */
const EXPOSURE_CREDIT_MAX = 2;

export interface WordEvidence {
  /**
   * Distinct reading sessions the word was on screen for — not the number of times it was rendered.
   */
  exposures: number;
  lookups: number;
  marks: number;
  unmarks: number;
  confirmed: number;
  notSure: number;
}

/**
 * Turn one word's event counts into a single observation.
 *
 * Two reasons to aggregate rather than fit per event. A paragraph produces ~30 exposures at once,
 * and feeding those to the estimator individually would let "read one paragraph" move the estimate
 * more than a hundred answered questions. And a word is one item: repeated evidence about it is
 * about the same difficulty, so it should be one observation with more weight, not many
 * observations pretending to be independent.
 *
 * Returns null when the evidence is too thin to say anything — silence is better than a guess.
 */
export function evidenceBalance(evidence: WordEvidence): { positive: number; negative: number } {
  const positive =
    evidence.confirmed * EVIDENCE_WEIGHT.confirmed +
    evidence.notSure * EVIDENCE_WEIGHT.notSure +
    // Only exposure across separate sessions counts, and only up to a point.
    (evidence.exposures >= SESSIONS_FOR_KNOWN
      ? Math.min(EXPOSURE_CREDIT_MAX, evidence.exposures - SESSIONS_FOR_KNOWN + 1) *
        EVIDENCE_WEIGHT.exposure
      : 0);

  const negative =
    evidence.lookups * EVIDENCE_WEIGHT.lookup + evidence.marks * EVIDENCE_WEIGHT.mark;

  return { positive, negative };
}

export function observationFor(
  evidence: WordEvidence,
  difficulty: number,
): Observation | null {
  const { positive, negative } = evidenceBalance(evidence);
  const net = positive - negative;
  if (Math.abs(net) < 0.1) return null;

  return {
    difficulty,
    known: net > 0,
    weight: Math.min(Math.abs(net), 2),
  };
}

/**
 * Derive one observation per word from the event log.
 *
 * The log is the only input: nothing here reads a counter, so a re-fold after a bug gives the same
 * answer as the first fold did.
 */
export async function observationsFor(
  userId: string,
  targetLang: string,
): Promise<Observation[]> {
  // The same time bound as the read path, for the same reason: evidence beyond four half-lives is
  // 6% of its weight, and reading it made the estimate cost grow with the whole history.
  const events = await Event.find({
    userId,
    targetLang,
    ts: { $gte: new Date(Date.now() - EVIDENCE_WINDOW_MS) },
  })
    .sort({ ts: -1 })
    .limit(MAX_EVENTS_FOLDED)
    .select("type lemmaKey items difficulty sessionId ts")
    .lean();

  const perWord = new Map<string, WordEvidence>();
  /** Sessions in which each word has been on screen, so repeats within one sitting collapse. */
  const sessions = new Map<string, Set<string>>();

  const bump = (lemmaKey: string, field: keyof WordEvidence) => {
    const entry =
      perWord.get(lemmaKey) ??
      { exposures: 0, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 };
    entry[field] += 1;
    perWord.set(lemmaKey, entry);
  };

  for (const event of events) {
    if (event.type === "exposure") {
      // One session key per event: the recorded session, or the calendar day when a client did not
      // send one. A batch covers many words and says the same thing about each of them.
      const session =
        (event as { sessionId?: string }).sessionId ||
        `day:${new Date((event as { ts?: Date }).ts ?? Date.now()).toISOString().slice(0, 10)}`;

      for (const item of event.items ?? []) {
        const seen = sessions.get(item.lemmaKey) ?? new Set<string>();
        seen.add(session);
        sessions.set(item.lemmaKey, seen);
        // Ensure the word has an entry even before its first counted session.
        bump(item.lemmaKey, "exposures");
      }
      continue;
    }
    if (!event.lemmaKey) continue;
    switch (event.type) {
      case "lookup":
        bump(event.lemmaKey, "lookups");
        break;
      case "mark":
        bump(event.lemmaKey, "marks");
        break;
      case "unmark":
        bump(event.lemmaKey, "unmarks");
        break;
      case "confirmed":
        bump(event.lemmaKey, "confirmed");
        break;
      case "not_sure":
        bump(event.lemmaKey, "notSure");
        break;
    }
  }

  if (perWord.size === 0) return [];

  const words = await Word.find({
    targetLang,
    lemmaKey: { $in: [...perWord.keys()] },
    origin: "import",
  })
    .select("lemmaKey pos difficulty")
    .lean();

  // Several entries can share a lemma key across parts of speech; the easiest reading is the one
  // the learner could have known, so take the lowest difficulty.
  const difficultyOf = new Map<string, number>();
  for (const word of words) {
    const current = difficultyOf.get(word.lemmaKey);
    if (current === undefined || word.difficulty < current) {
      difficultyOf.set(word.lemmaKey, word.difficulty);
    }
  }

  // Replace occurrence counts with distinct-session counts before scoring.
  for (const [lemmaKey, seen] of sessions) {
    const entry = perWord.get(lemmaKey);
    if (entry) entry.exposures = seen.size;
  }

  const observations: Observation[] = [];
  for (const [lemmaKey, evidence] of perWord) {
    const difficulty = difficultyOf.get(lemmaKey);
    if (difficulty === undefined || difficulty < 0) continue;
    const observation = observationFor(evidence, difficulty);
    if (observation) observations.push(observation);
  }
  return observations;
}
