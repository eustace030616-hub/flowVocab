/**
 * The read-time view of the learner model: `pKnown` per word, and the coverage it implies.
 *
 * Everything here is derived. The event log is the truth and `WordState` / `AbilityState` are
 * caches, so this module reads the log, folds it, and computes what the reader needs — no counter
 * is trusted and nothing is written.
 */

import { Event } from "../../models/Event";
import { Word } from "../../models/Word";
import { AbilityState } from "../../models/AbilityState";
import type { TargetLang } from "../lang";
import {
  EVIDENCE_WINDOW_MS,
  foldWordEvidence,
  MAX_EVENTS_FOLDED,
  modelPrediction,
  pKnownFor,
  type EventLike,
} from "./known";
import { coverageOf, type CoverageResult, type CoverageToken } from "./coverage";

/** Ability assumed when a learner has no estimate yet: the middle of the scale, no opinion. */
const UNMEASURED_THETA = 0.5;

/**
 * Probability the learner knows each of the given words.
 *
 * Bounded work: one query for the events, one for the words. Both are already indexed for exactly
 * this shape of read, and the model's prediction covers words with no history at all — which is what
 * makes a first reading of a new text estimable instead of blank.
 */
export interface KnownOptions {
  /**
   * Compound → its parts, for words that are not themselves vocabulary items.
   *
   * A German compound is usually absent from the lexicon while its parts are present, and the
   * learner's knowledge of it is compositional: understanding "Wortschatzaufbau" needs both
   * "Wortschatz" and "Aufbau". Scoring it as zero — which is what "not in the lexicon" produced —
   * made every compound look like an unknown word and depressed the coverage of any text containing
   * one.
   */
  parts?: Map<string, string[]>;
}

export interface KnownResult {
  probabilities: Map<string, number>;
  /**
   * The ability the probabilities were computed from, and how much evidence stands behind it.
   *
   * Returned because a probability derived from an unmeasured ability is a prediction, not a
   * measurement — and the interface has to be able to say so. Showing a learner "you know 82% of
   * this" before anything has been measured is the fabricated-number problem in a new costume.
   */
  ability: { theta: number; n: number; se: number } | null;
}

export async function knownProbabilities(
  userId: string,
  targetLang: TargetLang,
  lemmaKeys: string[],
  options: KnownOptions = {},
): Promise<KnownResult> {
  const unique = [...new Set(lemmaKeys)];
  const result = new Map<string, number>();
  const basis = { probabilities: result, ability: null as KnownResult["ability"] };
  if (unique.length === 0) return basis;

  const [abilityRow, events] = await Promise.all([
    AbilityState.findOne({ userId, targetLang }).select("theta n se").lean(),
    // Bounded by time: evidence older than four half-lives carries 6% of its weight and cannot
    // change the answer, so reading it made every page load do work proportional to the learner's
    // whole history for no effect. `ts` descending plus a ceiling keeps a pathological log from
    // hanging the read; the index on (userId, targetLang, ts) serves exactly this query.
    Event.find({
      userId,
      targetLang,
      ts: { $gte: new Date(Date.now() - EVIDENCE_WINDOW_MS) },
    })
      .sort({ ts: -1 })
      .limit(MAX_EVENTS_FOLDED)
      .select("type lemmaKey items sessionId ts")
      .lean(),
  ]);

  if (events.length >= MAX_EVENTS_FOLDED) {
    console.warn(
      `[reading] evidence fold hit the ${MAX_EVENTS_FOLDED}-event ceiling for ${userId}/${targetLang}; ` +
        "the estimate is based on the most recent events only",
    );
  }

  const theta = abilityRow?.theta ?? UNMEASURED_THETA;
  basis.ability = abilityRow
    ? { theta: abilityRow.theta, n: abilityRow.n ?? 0, se: abilityRow.se }
    : null;
  const folded = foldWordEvidence(events as EventLike[]);

  const words = await Word.find({
    targetLang,
    lemmaKey: { $in: unique },
    origin: "import",
  })
    .select("lemmaKey difficulty")
    .lean();

  // A lemma may have several entries across parts of speech; the easiest reading is the one the
  // learner could plausibly know, so coverage is not depressed by a rare homograph.
  const difficultyOf = new Map<string, number>();
  for (const word of words) {
    const current = difficultyOf.get(word.lemmaKey);
    if (current === undefined || word.difficulty < current) {
      difficultyOf.set(word.lemmaKey, word.difficulty);
    }
  }

  // Pass one: everything that is a vocabulary item, or has no decomposition to fall back on.
  const decomposable: string[] = [];
  for (const lemmaKey of unique) {
    const difficulty = difficultyOf.get(lemmaKey);
    if (difficulty !== undefined && difficulty >= 0) {
      const pModel = modelPrediction(theta, difficulty);
      result.set(lemmaKey, pKnownFor(folded.get(lemmaKey), pModel));
      continue;
    }
    if (options.parts?.get(lemmaKey)?.length) {
      decomposable.push(lemmaKey);
      continue;
    }
    // Not a vocabulary item we hold and not decomposable — a name, a tokenisation artefact.
    // Treated as unknown rather than silently counted as known.
    result.set(lemmaKey, 0);
  }

  // Pass two, after every base probability exists. A compound is scored by its weakest part:
  // knowing both parts is necessary, and multiplying several sub-0.5 probabilities compounds into a
  // number no learner is described by, so the minimum is the same judgement without the artefact.
  //
  // A separate pass because the parts are not guaranteed to precede the compound in the input — and
  // when they did not, `?? 0` scored every compound as unknown, which is the bug this ordering
  // fixes.
  for (const lemmaKey of decomposable) {
    let weakest = 1;
    for (const part of options.parts?.get(lemmaKey) ?? []) {
      weakest = Math.min(weakest, result.get(part) ?? 0);
    }
    result.set(lemmaKey, weakest);
  }

  return basis;
}

/** Coverage of one text, from the same probabilities. */
export async function coverageFor(
  userId: string,
  targetLang: TargetLang,
  tokens: CoverageToken[],
  options: KnownOptions = {},
): Promise<CoverageResult> {
  const { probabilities } = await knownProbabilities(
    userId,
    targetLang,
    tokens.map((token) => token.lemmaKey),
    options,
  );
  return coverageOf(tokens, (lemmaKey) => probabilities.get(lemmaKey) ?? 0);
}
