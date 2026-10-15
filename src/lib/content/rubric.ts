/**
 * The rubric a paragraph has to pass before it is served.
 *
 * A generator is only as good as its acceptance test. Without one, "the model wrote a paragraph"
 * is the whole quality story, and the failure is silent: text that is too hard, too easy, or full of
 * words the glossary cannot translate reaches the learner and looks fine in the database.
 *
 * So the rubric measures the text rather than trusting its label. It is deliberately about
 * properties a reader would notice:
 *
 *   i+1            at the target level, coverage lands where reading is supported rather than
 *                  effortless or impossible — the same thresholds the reader shows
 *   level          the text's median word difficulty falls in the band it claims
 *   translatable   most word tokens have a gloss, or the reader cannot help with what it cannot say
 *   length         long enough to be a text, short enough to read in one sitting
 *
 * Pure: it takes tokens and a difficulty lookup, so it is testable and can be run over a candidate
 * before anything is written to the database.
 */

import { levelMidpoint } from "../difficulty";
import { CEFR_LEVELS, type CefrLevel } from "../lang";
import { probabilityKnown } from "../learner/ability";
import { COMFORTABLE_COVERAGE, MINIMAL_COVERAGE } from "../learner/coverage";

/** One half-band either side of the level's midpoint is "at that level". */
const BAND_HALF_WIDTH = 1 / (CEFR_LEVELS.length * 2);

export interface RubricToken {
  lemmaKey: string;
  kind: string;
}

export interface RubricOptions {
  /** The level the text claims, which sets the band and the synthetic reader. */
  level: CefrLevel;
  /** Difficulty per lemma; -1 or missing means the vocabulary does not hold the word. */
  difficultyOf: (lemmaKey: string) => number | undefined;
  /** Whether the glossary can translate the word at all. */
  hasGloss: (lemmaKey: string) => boolean;
}

export interface RubricMetrics {
  wordTokens: number;
  /** Share of word tokens the vocabulary holds. */
  knownVocabulary: number;
  /** Share of word tokens with a translation available. */
  glossed: number;
  /** Median difficulty of the word tokens the vocabulary holds. */
  medianDifficulty: number;
  /** Band implied by the median, which is what the text actually is. */
  measuredLevel: CefrLevel | null;
  /** Coverage for a reader exactly at the claimed level — the i+1 check. */
  coverage: number;
  /** Tokens the vocabulary has no difficulty for: compounds and names, mostly. */
  unresolved: number;
}

export interface RubricResult {
  passed: boolean;
  issues: string[];
  metrics: RubricMetrics;
}

export const RUBRIC_LIMITS = {
  minWords: 45,
  maxWords: 220,
  /** Below this, too many words are untranslatable for the glossary to help with. */
  minGlossed: 0.9,
  /** Above this, the vocabulary has no idea what the text is made of. */
  maxUnresolvedShare: 0.15,
  /** i+1: supported reading. Below the floor the text is too hard at the level it claims. */
  minCoverage: MINIMAL_COVERAGE - 0.01,
  /** And not so easy that it teaches nothing. */
  maxCoverage: COMFORTABLE_COVERAGE + 0.01,
} as const;

function bandFor(level: CefrLevel): { low: number; high: number; centre: number } {
  const centre = levelMidpoint(level);
  return { low: centre - BAND_HALF_WIDTH, high: centre + BAND_HALF_WIDTH, centre };
}

export function levelForDifficulty(difficulty: number): CefrLevel | null {
  if (!(difficulty >= 0)) return null;
  const index = Math.min(
    CEFR_LEVELS.length - 1,
    Math.max(0, Math.floor(difficulty * CEFR_LEVELS.length)),
  );
  return CEFR_LEVELS[index];
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Measure a candidate paragraph.
 *
 * The coverage figure comes from the ability model run over the text with no learner history: it is
 * a property of the text against its claimed level, which is what a generator can be held to. A real
 * learner's coverage is computed separately, from their own estimate.
 */
export function measureParagraph(tokens: RubricToken[], options: RubricOptions): RubricMetrics {
  const words = tokens.filter((token) => token.kind === "word");
  const difficulties: number[] = [];
  let glossed = 0;
  let unresolved = 0;
  let covered = 0;
  const { centre } = bandFor(options.level);

  for (const token of words) {
    const difficulty = options.difficultyOf(token.lemmaKey);
    if (options.hasGloss(token.lemmaKey)) glossed += 1;

    if (difficulty === undefined || difficulty < 0) {
      unresolved += 1;
      // Unheld vocabulary counts as unknown rather than being skipped: a word the app cannot place
      // is a word the reader is on their own with.
      continue;
    }

    difficulties.push(difficulty);
    covered += probabilityKnown(centre, difficulty);
  }

  const wordTokens = words.length;
  const medianDifficulty = median(difficulties);

  return {
    wordTokens,
    knownVocabulary: wordTokens === 0 ? 0 : difficulties.length / wordTokens,
    glossed: wordTokens === 0 ? 0 : glossed / wordTokens,
    medianDifficulty,
    measuredLevel: levelForDifficulty(medianDifficulty),
    coverage: wordTokens === 0 ? 0 : covered / wordTokens,
    unresolved,
  };
}

export function checkParagraph(tokens: RubricToken[], options: RubricOptions): RubricResult {
  const metrics = measureParagraph(tokens, options);
  const issues: string[] = [];
  const { low, high } = bandFor(options.level);

  if (metrics.wordTokens < RUBRIC_LIMITS.minWords) {
    issues.push(`too short: ${metrics.wordTokens} words, minimum ${RUBRIC_LIMITS.minWords}`);
  }
  if (metrics.wordTokens > RUBRIC_LIMITS.maxWords) {
    issues.push(`too long: ${metrics.wordTokens} words, maximum ${RUBRIC_LIMITS.maxWords}`);
  }

  // A text's *reading* level is not its median word difficulty. Measured on the real paragraphs, a
  // reader needs to be about one and a half bands above the median word to reach the i+1 band —
  // which is how vocabulary works: a text at B1 is mostly A1–A2 words with a minority of B1 ones.
  //
  // So the check is one-sided. The median word must not be *above* the level the text claims, or the
  // text is harder than its label, but it may sit well below it — that is what well-pitched content
  // looks like. The coverage figure above is what establishes the level itself.
  if (Number.isFinite(metrics.medianDifficulty) && metrics.medianDifficulty > high) {
    issues.push(
      `harder than it claims: ${options.level} (words up to difficulty ${high.toFixed(2)}) ` +
        `but the median word is ${metrics.medianDifficulty.toFixed(2)} (${metrics.measuredLevel ?? "unknown"})`,
    );
  }

  if (metrics.coverage < RUBRIC_LIMITS.minCoverage) {
    issues.push(
      `too hard at ${options.level}: coverage ${(metrics.coverage * 100).toFixed(1)}%, ` +
        `minimum ${(RUBRIC_LIMITS.minCoverage * 100).toFixed(0)}%`,
    );
  }
  if (metrics.coverage > RUBRIC_LIMITS.maxCoverage) {
    issues.push(
      `too easy at ${options.level}: coverage ${(metrics.coverage * 100).toFixed(1)}%, ` +
        `maximum ${(RUBRIC_LIMITS.maxCoverage * 100).toFixed(0)}%`,
    );
  }

  if (metrics.glossed < RUBRIC_LIMITS.minGlossed) {
    issues.push(
      `untranslatable: only ${(metrics.glossed * 100).toFixed(0)}% of words have a gloss, ` +
        `minimum ${(RUBRIC_LIMITS.minGlossed * 100).toFixed(0)}%`,
    );
  }
  if (metrics.wordTokens > 0 && metrics.unresolved / metrics.wordTokens > RUBRIC_LIMITS.maxUnresolvedShare) {
    issues.push(
      `unknown vocabulary: ${metrics.unresolved} of ${metrics.wordTokens} words are not in the lexicon`,
    );
  }

  return { passed: issues.length === 0, issues, metrics };
}
