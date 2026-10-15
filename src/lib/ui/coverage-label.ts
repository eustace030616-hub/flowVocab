/**
 * How coverage is worded for the learner.
 *
 * Pure, because the arithmetic that produced the confusing version is exactly the kind of thing
 * that should be pinned by a test rather than eyeballed in JSX.
 *
 * Two faults made the badge unreadable, and both were real:
 *
 *   1. The label said "likely known" next to a number that means the *opposite* — `unknownIn` is one
 *      unknown word in N, so "likely known 1:64" read as a claim that 1 in 64 words are known.
 *
 *   2. The percentage was rounded to whole numbers while the ratio was computed from the unrounded
 *      value, so the two figures contradicted each other on screen: 98% implies 1 in 50, and the
 *      badge said 1 in 64. Neither number was wrong; they were derived from different roundings of
 *      the same quantity, which is the worst kind of disagreement because there is nothing to
 *      distrust.
 *
 * The ratio is now derived from the percentage that is actually displayed, so the two agree by
 * construction.
 */

import { verdictFor, type ReadingVerdict } from "../learner/coverage";

export interface CoverageLabel {
  /** Percentage, one decimal place, as displayed. */
  percent: string;
  /** One unfamiliar word in this many, derived from the displayed percentage. Null at 100%. */
  oneIn: number | null;
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * Format coverage so the percentage and the ratio always agree.
 *
 * One decimal place rather than none: at whole-number precision everything from 97.5% to 98.5%
 * renders as "98%", which is a range of 1-in-40 to 1-in-67 — the number stops distinguishing the
 * texts it is shown next to.
 */
export function coverageLabel(value: number): CoverageLabel {
  const percentValue = Math.round(clamp01(value) * 1000) / 10;
  const unknown = 1 - percentValue / 100;
  return {
    percent: percentValue.toFixed(1),
    oneIn: unknown <= 0 ? null : Math.max(1, Math.round(1 / unknown)),
  };
}

/** A word the learner says they do not know is treated as almost certainly unfamiliar, live. */
export const MARKED_KNOWN_CEILING = 0.05;

export interface LiveCoverage extends CoverageLabel {
  value: number;
  verdict: ReadingVerdict;
}

/**
 * Coverage as it stands while the learner is marking words.
 *
 * Two corrections over the arithmetic this replaces:
 *
 *   1. **A mark applies to the word, not the occurrence.** Knowledge is a property of a word, so
 *      marking one "the" has to change every "the" in the text — and in real paragraphs the repeated
 *      words are the function words, which are most of the tokens. Adjusting only the clicked span
 *      made the badge move by a fraction of what the learner had just said.
 *
 *   2. **The verdict is recomputed, not recalled.** The server decides the verdict for the text as
 *      loaded, but the percentage moves as words are marked. Keeping the server's word while showing
 *      a live figure produced a badge reading "90.1% · comfortable", which is contradictory: 90% is
 *      below the 95% threshold. Thresholds come from the shared module, so there is one rule.
 */
export function liveCoverage(
  tokens: Array<{ lemmaKey: string }>,
  pKnownOf: (lemmaKey: string) => number | undefined,
  markedLemmas: ReadonlySet<string>,
): LiveCoverage {
  if (tokens.length === 0) {
    return { ...coverageLabel(1), value: 1, verdict: "comfortable" };
  }

  let total = 0;
  for (const token of tokens) {
    const base = clamp01(pKnownOf(token.lemmaKey) ?? 0);
    total += markedLemmas.has(token.lemmaKey) ? Math.min(base, MARKED_KNOWN_CEILING) : base;
  }

  const value = total / tokens.length;
  return { ...coverageLabel(value), value, verdict: verdictFor(value) };
}
