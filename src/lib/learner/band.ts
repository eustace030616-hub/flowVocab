/**
 * How hard a passage is, counted in words the reader does not know.
 *
 * Coverage answers "what share of this could you read?" with a probability sum. This answers "how
 * many words in here are new to you?" with a count, which is the number a reader can actually act
 * on — five words to look up is a different evening from twenty.
 *
 * ## What counts as an unknown word
 *
 *   marked        the reader said so. A mark counts whatever the model thinks — that is the point of
 *                 marking, and it is the one signal here that is not an inference.
 *   predicted     the model puts the word below `UNKNOWN_THRESHOLD`.
 *
 * Counting both is what lets an unread passage be graded at all. Marks alone are retrospective: before
 * reading, nobody has marked anything, so every passage would be "easy".
 *
 * ## Why the threshold is 0.8
 *
 * It was chosen so the count agrees with the coverage judgement the app already trusts, on real
 * passages. At θ=0.25 the passages below the 95% coverage floor score 5-6 unknown words (hard) and
 * the readable ones score 3-4 (easy); at θ=0.5 everything readable scores 0-1.
 *
 *     pKnown < 0.8   ⇔   word difficulty > θ + 0.233   (about 1.4 CEFR bands above the reader)
 *
 * A lower cutoff is useless — at `pKnown < 0.5` an A2 learner scores 0 unknown words even on a
 * passage whose coverage is 89%, because knowledge is spread across many 0.8s and 0.9s rather than
 * concentrated in a few words that are more likely unknown than known.
 *
 * ## A level-edge rule was tried and rejected
 *
 * Counting words above the reader's level band instead — the other honest reading of "a word I do not
 * know" — over-counts badly. On a readable A2 passage (median word 0.08, coverage 95%) it reports
 * **20** unknown words, because an A2 text legitimately contains many words above the A2 edge. The
 * probability rule reports 4-6 for the same passage, which is what a reader would say.
 *
 * ## Counting words, not occurrences
 *
 * Distinct lemmas, so a hard word repeated eight times is one unknown word, not eight. The band is
 * about vocabulary load; coverage already accounts for repetition, because it sums over tokens.
 */

import { CEFR_LEVELS, type CefrLevel } from "../lang";
import type { Span } from "../tokenize";

/**
 * Below this, the model considers the word unknown to the reader.
 *
 * Expressed on the same axis as difficulty: `pKnown < 0.8` is a word more than 0.233 above θ.
 */
export const UNKNOWN_THRESHOLD = 0.8;

export type PassageBand = "easy" | "hard" | "very_hard";

/** Band edges, inclusive. `easy` through 4, `hard` through 10, `very_hard` above. */
export const BAND_EDGES = { easyMax: 4, hardMax: 10 } as const;

export function passageBand(unknownCount: number): PassageBand {
  if (unknownCount <= BAND_EDGES.easyMax) return "easy";
  if (unknownCount <= BAND_EDGES.hardMax) return "hard";
  return "very_hard";
}

/**
 * The top edge of the level band a given ability sits in.
 *
 * A word above this is above the reader's level, which is the condition that makes the count usable
 * above A2. Nothing here needs the level *label*, only the edge, so it is computed from θ directly.
 */
export function bandHighFor(theta: number, bands = 6): number {
  const index = Math.min(bands - 1, Math.max(0, Math.floor(theta * bands)));
  return (index + 1) / bands;
}

export interface UnknownWordsResult {
  /** Distinct lemmas the reader does not know. */
  count: number;
  /** The lemmas themselves, for showing which words are the hurdle. */
  lemmas: string[];
  /** How many of them the reader marked personally, as opposed to the model predicting them. */
  markedCount: number;
}

/**
 * The unknown words in a passage.
 *
 * `isMarked` is keyed by the lemma rather than the occurrence, so marking one instance of a repeated
 * word settles all of them — which is what a reader means by "I don't know this word".
 */
export function unknownWords(
  spans: Span[],
  options: {
    pKnownOf: (lemmaKey: string) => number | undefined;
    isMarked?: (lemmaKey: string) => boolean;
    threshold?: number;
  },
): UnknownWordsResult {
  const threshold = options.threshold ?? UNKNOWN_THRESHOLD;
  const lemmas: string[] = [];
  let markedCount = 0;

  for (const span of spans) {
    if (span.kind !== "word") continue;
    const key = span.lemmaKey;
    if (lemmas.includes(key)) continue;

    const marked = options.isMarked?.(key) ?? false;
    const pKnown = options.pKnownOf(key) ?? 0;
    if (!marked && pKnown >= threshold) continue;

    lemmas.push(key);
    if (marked) markedCount += 1;
  }

  return { count: lemmas.length, lemmas, markedCount };
}

/**
 * Which brief level to write for, given an ability estimate.
 *
 * **The level the estimate falls in.** Your level determines your text: a B1 estimate gets B1 text.
 *
 * ## A one-band-above rule was tried here, and removed
 *
 * It was added to break a bootstrapping deadlock, measured when the estimate could not rise at all:
 * a fresh learner reading passages unmarked went 0.500 → 0.532 → 0.555 → 0.555 and stopped, because
 * reading "known" only proves knowledge up to the word's difficulty and the text was never harder
 * than the estimate.
 *
 * That deadlock turned out to be caused by the *evidence weights*, not by the choice of text. With
 * the prediction reduced to a light prior and an unmarked reading worth most of a mark, the estimate
 * rises at its own level and needs no help:
 *
 *     θ = 0.500 → 0.617 → 0.686 → 0.744 → 0.783 → 0.799 → 0.829   (six passages, no generation)
 *
 * The reason is that a text pitched at a level contains words *above* that level — an A2 passage
 * tops out around difficulty 0.55, a B1 passage higher — so reading it is already an upward probe.
 * With the weights fixed, the +1 only made the served text disagree with the level the interface
 * reported: "your level is B1" next to a B2 passage.
 *
 * Clamped to the range briefs cover. Below A2 the vocabulary is too thin to build a scene; above B2 a
 * generated text is not what this reader is for.
 *
 * Both the generate route and the pregenerator call this, so the stock cannot be written at one level
 * while the button asks for another — which is exactly what happened when the route moved and the
 * pregenerator did not.
 */
export function targetBriefLevel(theta: number): CefrLevel {
  const index = Math.min(CEFR_LEVELS.length - 1, Math.max(0, Math.floor(theta * CEFR_LEVELS.length)));
  const point = CEFR_LEVELS[index];
  if (point === "A1") return "A2";
  if (point === "C1" || point === "C2") return "B2";
  return point as CefrLevel;
}
