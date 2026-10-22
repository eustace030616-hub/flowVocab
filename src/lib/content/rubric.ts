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
 *   i+1            at the target level, the reader meets 5-10 words they do not know — the same
 *                  count the reader's badge shows, and the same band edges. Coverage is the floor
 *                  below it: a text has to be readable *and* contain something to learn.
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
import { BAND_EDGES, UNKNOWN_THRESHOLD, unknownWords } from "../learner/band";
import { COMFORTABLE_COVERAGE, MINIMAL_COVERAGE } from "../learner/coverage";

/** One half-band either side of the level's midpoint is "at that level". */
const BAND_HALF_WIDTH = 1 / (CEFR_LEVELS.length * 2);

export interface RubricToken {
  lemmaKey: string;
  kind: string;
  /** The text as written. Needed to compare sentences; optional so existing callers still work. */
  surface?: string;
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
  /** Coverage for a reader exactly at the claimed level. */
  coverage: number;
  /**
   * How many words a reader exactly at the claimed level does not know — the i+1 check.
   *
   * Distinct lemmas, so a hard word repeated eight times is one word, and words the vocabulary
   * cannot place count as unknown for the same reason they count as unknown in coverage: a word the
   * app cannot place is a word the reader is on their own with.
   */
  unknownCount: number;
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
  /**
   * i+1: supported reading. Below the floor the text is too hard at the level it claims.
   *
   * **Calibration, settled by measurement.** The German A2 brief failed four attempts at 92.3%,
   * 93.3%, 93.4% and 94.0% against this floor, which raised the obvious question of whether the
   * floor is simply too strict. It is not:
   *
   *   - It already sits *below* the literature's figure. 95% is Nation's minimal coverage and
   *     Laufer & Ravenhorst-Kalovski's 4,000–5,000 families; the floor concedes a point to
   *     generation. Lowering it further would be fitting the threshold to the generator.
   *   - It is reachable at every level, including A2. A text whose words all sit at the learner's
   *     level scores exactly `KNOWN_AT_LEVEL` = 95%, and the accepted B1/B2 paragraphs measure
   *     97.8–98.8%. The A2 failures were not the floor's fault: the text contained words above A2.
   *   - It was fixed by telling the model *which* words were too hard, not by moving the line. Once
   *     the repair feedback named them (see `generate.ts`), A2 cleared the floor on the next
   *     attempt.
   *
   * So the constraint on A2 is vocabulary, not the threshold, and it is enforced the honest way:
   * by measuring and asking for specific simplifications.
   */
  minCoverage: MINIMAL_COVERAGE - 0.02,
  /** And not so easy that it teaches nothing. */
  maxCoverage: COMFORTABLE_COVERAGE + 0.01,
} as const;

/**
 * The unknown-word band a passage *aims* at, as a reported target rather than a gate.
 *
 * Attempted as an acceptance test and withdrawn — see the note in `checkParagraph`. It stays here
 * because it is the number the reader's badge shows and the one the QA harness reports, and because
 * a smoothed version of it (a share of above-level words, rather than a count) is the obvious next
 * thing to try.
 */
export const UNKNOWN_TARGET = {
  min: BAND_EDGES.easyMax + 1,
  max: BAND_EDGES.hardMax,
} as const;

export function bandFor(level: CefrLevel): { low: number; high: number; centre: number } {
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

  // The same count the reader's badge shows, by the same rule: predicted below the threshold, or
  // unplaced. There are no marks to consider here.
  const unknownLemmas = unknownWords(
    words.map((token) => ({ ...token, kind: "word" }) as Parameters<typeof unknownWords>[0][number]),
    {
      pKnownOf: (key) => {
        const difficulty = options.difficultyOf(key);
        return difficulty === undefined || difficulty < 0 ? 0 : probabilityKnown(centre, difficulty);
      },
    },
  ).count;

  const wordTokens = words.length;
  const medianDifficulty = median(difficulties);

  return {
    wordTokens,
    knownVocabulary: wordTokens === 0 ? 0 : difficulties.length / wordTokens,
    glossed: wordTokens === 0 ? 0 : glossed / wordTokens,
    medianDifficulty,
    measuredLevel: levelForDifficulty(medianDifficulty),
    coverage: wordTokens === 0 ? 0 : covered / wordTokens,
    unknownCount: unknownLemmas,
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
  // i+1 by count rather than by probability mass: the reader should meet a handful of new words,
  // not none and not so many that the text stops being readable. This replaces a coverage *ceiling*,
  // which was the same judgement made coarsely — a text with six unknown words cannot also have 99%
  // coverage, so the count subsumes it and is legible to a reader ("5 new words").
  // The unknown count is *reported*, not required. It was tried as the acceptance test and cannot
  // serve as one: it is a knife-edge over a distribution the generator controls only weakly.
  //
  //   B1   4 attempts, 3/2/4/1 unknown — "too easy" every time, coverage 97-98%
  //   B2   4 attempts, 0/1/2/1 unknown — "too easy" every time, coverage 98-99%
  //   A2   with a level-edge rule, 20/20/19/19 unknown — "too hard" every time, coverage 95%
  //
  // B1 and B2 texts are written conservatively from easier vocabulary (median word 0.08-0.17), so
  // almost nothing clears any sensible edge; A2 texts inevitably contain twenty words above the A2
  // edge even at 95% coverage. Coverage is a *share* and moves smoothly with the text; a count of
  // above-edge words does not. So the floor and ceiling below remain the gate, and the count goes to
  // the metrics and the reader's badge, where it is a label rather than a threshold.
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


/**
 * ── Passages: three or four paragraphs ──────────────────────────────────────────────────────
 *
 * A longer text fails in ways a single paragraph cannot. One paragraph can only be incoherent; four
 * can also be *repetitive* (the same situation restated), *unbalanced* (a two-line last paragraph),
 * or *stuck* (nothing changes from beginning to end). And the failure is invisible to an aggregate
 * measurement: four paragraphs that each pass the rubric on their own can still be four ways of
 * saying it rained.
 *
 * So the checks are layered, and each layer catches something the one below cannot:
 *
 *   per paragraph    the rubric, applied independently. A learner reads paragraph by paragraph, so a
 *                    hard third paragraph is not rescued by an easy first one, and averaging would
 *                    hide exactly the paragraph they give up on.
 *   whole text       length, paragraph count, and no repeated sentence.
 *   progression      every paragraph after the first must bring new words. A paragraph whose
 *                    vocabulary is already covered is restatement, whatever its sentences say.
 *
 * The judgement layer above these — is it a story, does it end — stays with the reader model, because
 * no amount of counting notices that a text is boring.
 */

export const PASSAGE_LIMITS = {
  /**
   * Two, not three, because A2 cannot fill three.
   *
   * Measured on repeated generation at A2 with three paragraphs: every attempt landed on one side of
   * the reading bar or the other — 200+ words at 90.6-93.0% coverage per paragraph, or under the word
   * minimum at 95%+. The vocabulary that exists at A2 does not stretch to 200 words inside the level.
   * That is information about A2, not a fault in the text, so an A2 brief asks for two paragraphs and
   * B1/B2 ask for three.
   */
  minParagraphs: 2,
  maxParagraphs: 4,
  /** A paragraph shorter than this is a fragment, not a paragraph. */
  minParagraphWords: 35,
  /**
   * The coverage floor for a single paragraph, one point below the whole-text floor.
   *
   * A paragraph is 35-130 words, so its coverage is a noisier measurement than a 300-word passage's,
   * and at the same threshold a paragraph measuring 94.0% against a floor of 94.0% fails on rounding
   * rather than on difficulty. One point of slack removes the knife-edge without hiding a paragraph
   * that is genuinely harder than the rest — 90.9% still fails.
   */
  paragraphCoverageSlack: 0.01,
  /** Two substantial paragraphs, which is what an A2 brief asks for. */
  minTotalWords: 140,
  maxTotalWords: 560,
  /**
   * Share of a paragraph's distinct lemmas that must not have appeared earlier.
   *
   * Set low deliberately. A continuing scene *should* reuse its people, places and verbs — that is
   * what makes it a scene rather than a list of topics — so the check is aimed at a paragraph that
   * brings nothing at all, not at ordinary lexical continuity.
   */
  minNewLemmaShare: 0.2,
  /**
   * Repeating a *long* sentence is padding; repeating a short one is how simple prose works.
   *
   * Measured: with every repeated sentence rejected, four attempts in a row failed on lines like
   * "Ich habe keinen Schirm." and "Ich öffne die Tür." — the story's own motif, restated. At A2 that
   * is ordinary, and graded readers repeat deliberately. What the check is for is a paragraph that
   * re-runs an earlier *sentence* rather than continuing, which only shows up in a sentence long
   * enough to carry content.
   */
  minRepeatedSentenceWords: 6,
  /** A short formula repeated this many times is padding whatever its length. */
  maxShortSentenceRepeats: 3,
} as const;

/**
 * Nouns a writer reaches for when it is avoiding the real word.
 *
 * Observed, not imagined. A generated A2 passage about being caught in the rain contained
 *
 *     "Ich habe kein Gerät für Schutz."        …for "Ich habe keinen Regenschirm."
 *
 * and passed every objective check and the coherence judge three times out of three. The writer had
 * been told to keep to a small vocabulary and to "change what happens in the scene rather than
 * forcing an awkward phrase"; it did neither, and produced a sentence no German speaker would say.
 *
 * These nouns are the tell. They are close to meaningless on their own, so their only job is to be
 * the head of a description that belongs to one ordinary noun. Legitimate uses exist — a real
 * *Gerät* in a technical scene — which is why this is one flag and not a hard rule, but at A2 and B1
 * a described object is nearly always an avoided word.
 */
export const AVOIDANCE_NOUNS = [
  "gerät",
  "apparat",
  "vorrichtung",
  "gegenstand",
  "zeug",
  "konstruktion",
  "anlage",
  "device",
  "apparatus",
  "contraption",
  "thingamajig",
] as const;

/** How many avoidance nouns one passage may contain before it is questioned. */
export const MAX_AVOIDANCE_NOUNS = 0;

export interface PassageResult {
  passed: boolean;
  issues: string[];
  metrics: PassageMetrics;
}

export interface PassageMetrics {
  paragraphs: RubricMetrics[];
  /** Lemmas from `AVOIDANCE_NOUNS` — the writer describing an object instead of naming it. */
  avoidanceNouns: string[];
  paragraphCount: number;
  wordTokens: number;
  coverage: number;
  glossed: number;
  measuredLevel: CefrLevel | null;
  unknownCount: number;
  repeatedSentences: string[];
  /** New-lemma share per paragraph, by position. The first is 1 by definition. */
  newLemmaShare: number[];
  /** Words per paragraph, so an unbalanced text is visible rather than averaged away. */
  paragraphWords: number[];
}

/** Sentences as normalised word sequences — punctuation-free, so a re-punctuated repeat still counts. */
function sentencesOf(tokens: RubricToken[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token.kind === "punct") {
      const surface = token.surface ?? "";
      if (/[.!?]/.test(surface) && current.length > 0) {
        out.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(token.lemmaKey);
  }
  if (current.length > 0) out.push(current.join(" "));
  return out;
}

export function measurePassage(paragraphs: RubricToken[][], options: RubricOptions): PassageMetrics {
  const perParagraph = paragraphs.map((tokens) => measureParagraph(tokens, options));

  const wordTokens = perParagraph.reduce((sum, m) => sum + m.wordTokens, 0);
  const covered = paragraphs.reduce(
    (sum, tokens, index) => sum + perParagraph[index].coverage * perParagraph[index].wordTokens,
    0,
  );
  const glossedWords = perParagraph.reduce((sum, m) => sum + m.glossed * m.wordTokens, 0);

  // Sentence repetition, across the whole passage rather than within a paragraph only.
  const seen = new Map<string, number>();
  for (const tokens of paragraphs) {
    for (const sentence of sentencesOf(tokens)) {
      seen.set(sentence, (seen.get(sentence) ?? 0) + 1);
    }
  }
  const repeatedSentences = [...seen.entries()]
    .filter(([sentence, n]) => {
      const words = sentence.split(" ").length;
      // A long sentence twice is a paragraph standing still; a short one twice is a motif.
      if (words >= PASSAGE_LIMITS.minRepeatedSentenceWords) return n > 1;
      return n > PASSAGE_LIMITS.maxShortSentenceRepeats;
    })
    .map(([sentence]) => sentence);

  // Progression: how much of each paragraph is new to the passage so far.
  const known = new Set<string>();
  const newLemmaShare = paragraphs.map((tokens, index) => {
    const lemmas = [...new Set(tokens.filter((t) => t.kind === "word").map((t) => t.lemmaKey))];
    const fresh = lemmas.filter((lemma) => !known.has(lemma)).length;
    for (const lemma of lemmas) known.add(lemma);
    if (lemmas.length === 0) return 0;
    return index === 0 ? 1 : fresh / lemmas.length;
  });

  const difficulties = perParagraph.map((m) => m.medianDifficulty).filter((d) => Number.isFinite(d));
  const medianDifficulty = median(difficulties);

  return {
    paragraphs: perParagraph,
    avoidanceNouns: [
      ...new Set(
        paragraphs
          .flat()
          .filter((token) => token.kind === "word")
          .map((token) => token.lemmaKey)
          .filter((lemma) => (AVOIDANCE_NOUNS as readonly string[]).includes(lemma)),
      ),
    ],
    paragraphCount: paragraphs.length,
    wordTokens,
    coverage: wordTokens === 0 ? 0 : covered / wordTokens,
    glossed: wordTokens === 0 ? 0 : glossedWords / wordTokens,
    measuredLevel: levelForDifficulty(medianDifficulty),
    unknownCount: perParagraph.reduce((sum, m) => sum + m.unknownCount, 0),
    repeatedSentences,
    newLemmaShare,
    paragraphWords: perParagraph.map((m) => m.wordTokens),
  };
}

export function checkPassage(paragraphs: RubricToken[][], options: RubricOptions): PassageResult {
  const metrics = measurePassage(paragraphs, options);
  const issues: string[] = [];

  if (metrics.paragraphCount < PASSAGE_LIMITS.minParagraphs) {
    issues.push(
      `too few paragraphs: ${metrics.paragraphCount}, minimum ${PASSAGE_LIMITS.minParagraphs}`,
    );
  }
  if (metrics.paragraphCount > PASSAGE_LIMITS.maxParagraphs) {
    issues.push(
      `too many paragraphs: ${metrics.paragraphCount}, maximum ${PASSAGE_LIMITS.maxParagraphs}`,
    );
  }
  if (metrics.wordTokens < PASSAGE_LIMITS.minTotalWords) {
    issues.push(`too short: ${metrics.wordTokens} words, minimum ${PASSAGE_LIMITS.minTotalWords}`);
  }
  if (metrics.wordTokens > PASSAGE_LIMITS.maxTotalWords) {
    issues.push(`too long: ${metrics.wordTokens} words, maximum ${PASSAGE_LIMITS.maxTotalWords}`);
  }

  // Per paragraph, and named by position, so a retry can be told which one to rewrite.
  metrics.paragraphs.forEach((paragraph, index) => {
    const at = `paragraph ${index + 1}`;
    if (paragraph.wordTokens < PASSAGE_LIMITS.minParagraphWords) {
      issues.push(
        `${at} is a fragment: ${paragraph.wordTokens} words, minimum ${PASSAGE_LIMITS.minParagraphWords}`,
      );
    }
    const floor = RUBRIC_LIMITS.minCoverage - PASSAGE_LIMITS.paragraphCoverageSlack;
    if (paragraph.coverage < floor) {
      issues.push(
        `${at} is too hard: coverage ${(paragraph.coverage * 100).toFixed(1)}%, ` +
          `minimum ${(floor * 100).toFixed(0)}%`,
      );
    }
    if (paragraph.glossed < RUBRIC_LIMITS.minGlossed) {
      issues.push(
        `${at} has too few translations: ${(paragraph.glossed * 100).toFixed(0)}%, ` +
          `minimum ${(RUBRIC_LIMITS.minGlossed * 100).toFixed(0)}%`,
      );
    }
  });

  if (metrics.repeatedSentences.length > 0) {
    issues.push(
      `a sentence is repeated: "${metrics.repeatedSentences[0]}" — the passage must move forward, ` +
        `not restate itself`,
    );
  }

  metrics.newLemmaShare.forEach((share, index) => {
    if (index === 0) return;
    if (share < PASSAGE_LIMITS.minNewLemmaShare) {
      issues.push(
        `paragraph ${index + 1} brings nothing new: only ${(share * 100).toFixed(0)}% of its words ` +
          `are new to the passage, minimum ${(PASSAGE_LIMITS.minNewLemmaShare * 100).toFixed(0)}%`,
      );
    }
  });

  // A vague noun heading a description is the signature of an avoided word. Named in the feedback, so
  // the retry can either use the real word or change what happens.
  if (metrics.avoidanceNouns.length > MAX_AVOIDANCE_NOUNS) {
    issues.push(
      `the text describes something instead of naming it: ${metrics.avoidanceNouns.join(", ")} — ` +
        `use the ordinary word for the thing, or change the scene so the thing is not needed`,
    );
  }

  // The median word must not sit above the level the text claims, same one-sided rule as a paragraph.
  const { high } = bandFor(options.level);
  for (const [index, paragraph] of metrics.paragraphs.entries()) {
    if (Number.isFinite(paragraph.medianDifficulty) && paragraph.medianDifficulty > high) {
      issues.push(
        `paragraph ${index + 1} is harder than it claims: median word ` +
          `${paragraph.medianDifficulty.toFixed(2)} above ${options.level}`,
      );
    }
  }

  return { passed: issues.length === 0, issues, metrics };
}
