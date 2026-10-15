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
