/**
 * Lexical coverage: what fraction of a text the learner already knows.
 *
 * This is the operational definition of i+1, and it is deliberately not a level index. "B1 text"
 * says nothing checkable; "you know 96% of these words" is a measurement, and it is the same
 * measurement for every language and script, because it never assumes a single level axis.
 *
 * The thresholds are the literature's, not invented here:
 *
 *   95%   minimal coverage — Nation, and Laufer & Ravenhorst-Kalovski's 4,000–5,000 word families
 *   98%   comfortable free reading — Nation's 8,000–9,000 families for written text
 *
 * Expressed the way a learner can act on it, "one unknown word in N" where N = 1/(1 − coverage).
 * Pure, so the arithmetic and the thresholds are tested rather than assumed.
 */

/** Below this, comprehension breaks down and glosses are not enough. */
export const MINIMAL_COVERAGE = 0.95;
/** At or above this, the text can be read without support. */
export const COMFORTABLE_COVERAGE = 0.98;

export type ReadingVerdict = "too_hard" | "supported" | "comfortable";

export interface CoverageResult {
  /** Mean probability of knowing each token, [0, 1]. */
  coverage: number;
  /** Tokens counted — word tokens only; punctuation and numbers are excluded. */
  tokens: number;
  /** The actionable form: "one unknown word in N". */
  unknownIn: number;
  verdict: ReadingVerdict;
}

/** A token, as far as coverage is concerned. */
export interface CoverageToken {
  lemmaKey: string;
  kind: string;
}

/**
 * Mean probability of knowing the text's word tokens.
 *
 * Proper nouns and numbers are excluded: a name the learner has never seen is not an unknown word
 * in the sense that matters, and counting it would make every text with a person in it look harder
 * than it reads.
 */
export function coverageOf(
  tokens: CoverageToken[],
  probabilityOf: (lemmaKey: string) => number,
): CoverageResult {
  const counted = tokens.filter((token) => token.kind === "word");
  if (counted.length === 0) {
    return { coverage: 1, tokens: 0, unknownIn: Number.POSITIVE_INFINITY, verdict: "comfortable" };
  }

  let total = 0;
  for (const token of counted) {
    const p = probabilityOf(token.lemmaKey);
    total += Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  }

  const coverage = total / counted.length;
  const unknown = 1 - coverage;
  return {
    coverage,
    tokens: counted.length,
    // Rounded to a whole word: "1 in 24" is actionable, "1 in 24.3" is not.
    unknownIn: unknown <= 0 ? Number.POSITIVE_INFINITY : Math.max(1, Math.round(1 / unknown)),
    verdict: verdictFor(coverage),
  };
}

export function verdictFor(coverage: number): ReadingVerdict {
  if (coverage >= COMFORTABLE_COVERAGE) return "comfortable";
  if (coverage >= MINIMAL_COVERAGE) return "supported";
  return "too_hard";
}
