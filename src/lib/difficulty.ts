/**
 * Turning corpus frequency into a continuous difficulty score.
 *
 * The problem this solves: CEFR labels arrive in six buckets, and a bucket spans ~1,000–2,500
 * words. That is far too coarse to serve "+1" — the B2 band alone holds 2,778 rows, more than
 * A1 and A2 combined. Meanwhile most words have no label at all (no German C1/C2 list has ever
 * been published), and those are exactly the words a learner is about to meet.
 *
 * So difficulty is derived from frequency, and the CEFR lists are used to *calibrate* that
 * mapping rather than to be the scale itself:
 *
 *   1. take every word that has both a frequency score and a CEFR label
 *   2. compute the median frequency of each level — that is where the level "sits" in frequency
 *      space, measured rather than assumed
 *   3. build a monotone piecewise-linear map from frequency to difficulty through those points
 *
 * Every word then gets a continuous difficulty, including words no list covers. Where a list
 * label exists it wins; where it does not, a level can be *estimated* from the same curve and is
 * marked as an estimate.
 *
 * Frequency comes from `wordfreq` (Zipf: log10 of occurrences per billion words, so higher means
 * more frequent and difficulty *decreases* with Zipf).
 */

import { CEFR_LEVELS, type CefrLevel } from "./lang";

export const DIFFICULTY_VERSION = "zipf-cefr-median-v1";

export interface CalibrationAnchor {
  /** Median Zipf score of the words at this level. */
  zipf: number;
  /** Target difficulty in [0,1] for the level this anchor came from. */
  difficulty: number;
  level: CefrLevel;
  samples: number;
}

export interface Calibration {
  version: string;
  /**
   * Sorted by zipf *ascending*, which means difficulty descends: rare words are hard.
   */
  anchors: CalibrationAnchor[];
  /** Words that had both a frequency score and a label. */
  samples: number;
  /** Levels that contributed no samples and were omitted. */
  missing: CefrLevel[];
}

/** Difficulty target for a level: the midpoint of its sixth of the scale. */
export function levelMidpoint(level: CefrLevel): number {
  const index = CEFR_LEVELS.indexOf(level);
  return index < 0 ? -1 : (index + 0.5) / CEFR_LEVELS.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface Observation {
  zipf: number;
  level: CefrLevel;
}

/**
 * Fit the frequency→difficulty curve from labelled words.
 *
 * Monotonicity is enforced rather than assumed. The English labels come from two lists built to
 * different standards (CEFR-J for A1–B2, Octanove for C1–C2) and they disagree about 116 rows, so
 * raw medians can be non-monotone — e.g. C1 sitting at a *more* frequent median than B2. Letting
 * that through would make the curve claim rarer words are easier. Levels are therefore walked
 * easiest-first and each median is clamped to be no more frequent than the previous one.
 */
export function fitZipfCalibration(observations: Observation[]): Calibration {
  const byLevel = new Map<CefrLevel, number[]>();
  for (const obs of observations) {
    if (!(obs.zipf > 0)) continue;
    const bucket = byLevel.get(obs.level);
    if (bucket) bucket.push(obs.zipf);
    else byLevel.set(obs.level, [obs.zipf]);
  }

  const missing: CefrLevel[] = [];
  const anchors: CalibrationAnchor[] = [];

  // Easiest first, so "no more frequent than the previous level" is the monotone direction.
  let previousZipf = Number.POSITIVE_INFINITY;
  for (const level of CEFR_LEVELS) {
    const samples = byLevel.get(level);
    if (!samples || samples.length === 0) {
      missing.push(level);
      continue;
    }
    const raw = median(samples);
    const zipf = Math.min(raw, previousZipf);
    previousZipf = zipf;
    anchors.push({ zipf, difficulty: levelMidpoint(level), level, samples: samples.length });
  }

  return {
    version: DIFFICULTY_VERSION,
    // Ascending zipf == descending difficulty.
    anchors: anchors.sort((a, b) => a.zipf - b.zipf),
    samples: observations.filter((o) => o.zipf > 0).length,
    missing,
  };
}

/**
 * Map a Zipf score onto difficulty in [0,1].
 *
 * Outside the calibrated range the nearest anchor's difficulty is held rather than extrapolated:
 * a word rarer than the rarest C2 anchor is not "more than C2", and claiming otherwise would put
 * nonsense at the top of the ladder.
 */
export function difficultyFromZipf(zipf: number, calibration: Calibration): number {
  if (!(zipf > 0) || calibration.anchors.length === 0) return -1;
  const anchors = calibration.anchors;
  if (anchors.length === 1) return anchors[0].difficulty;

  // anchors are ascending in zipf, so descending in difficulty
  if (zipf <= anchors[0].zipf) return anchors[0].difficulty;
  if (zipf >= anchors[anchors.length - 1].zipf) return anchors[anchors.length - 1].difficulty;

  for (let i = 0; i < anchors.length - 1; i += 1) {
    const low = anchors[i];
    const high = anchors[i + 1];
    if (zipf >= low.zipf && zipf <= high.zipf) {
      const span = high.zipf - low.zipf;
      const t = span === 0 ? 0 : (zipf - low.zipf) / span;
      return low.difficulty + t * (high.difficulty - low.difficulty);
    }
  }
  return anchors[anchors.length - 1].difficulty;
}

/**
 * The CEFR band a difficulty falls in. Used only when no list supplied a label, and always
 * written with `levelEstimated: true` so the interface can say "estimated" rather than imply a
 * measurement.
 */
export function levelFromDifficulty(difficulty: number): CefrLevel | null {
  if (!(difficulty >= 0)) return null;
  const index = Math.min(CEFR_LEVELS.length - 1, Math.max(0, Math.floor(difficulty * CEFR_LEVELS.length)));
  return CEFR_LEVELS[index];
}

/** A compact, loggable summary of a fitted curve. */
export function describeCalibration(calibration: Calibration): string {
  const parts = calibration.anchors.map(
    (a) => `${a.level} zipf≤${a.zipf.toFixed(2)} (n=${a.samples})`,
  );
  return `${calibration.version}: ${parts.join(" · ")}${
    calibration.missing.length ? ` · no samples for ${calibration.missing.join(",")}` : ""
  }`;
}
