/**
 * Parser and inverter for CC-CEDICT.
 *
 * Licence: CC BY-SA 4.0. Share-alike, so the gloss text stays in its own `Gloss` documents
 * alongside ding rather than being merged into the shared vocabulary (see models/Gloss.ts).
 *
 * Format, one entry per line:
 *
 *     傳統 传统 [chuan2 tong3] /tradition/traditional/CL:個|个[ge4]/
 *     Traditional Simplified [pin1yin1] /gloss/gloss/…
 *
 * CC-CEDICT is Chinese→English. Our English track needs the other direction, so the glosses are
 * indexed in reverse: an English gloss becomes a key whose value is the Chinese words that
 * translate it. That inversion is the whole trick, and it is lossy in one specific way worth
 * knowing — a gloss is a *phrase*, so only glosses that look like a headword are usable as keys.
 *
 * Pure and separate from the database so the inversion can be tested.
 */

export interface CedictEntry {
  traditional: string;
  simplified: string;
  pinyin: string;
  glosses: string[];
}

export interface InvertedGlosses {
  /** Normalised English gloss → simplified Chinese forms, in order of first appearance. */
  byGloss: Map<string, string[]>;
  /**
   * Simplified form → how many distinct English glosses it translates.
   *
   * The precision half of the ranking. Frequency alone is not enough: 那 is extremely frequent and
   * is listed as a gloss of "beautiful", while 美 is less frequent and simply *is* the word.
   */
  genericness: Map<string, number>;
  /** Simplified form → its normalised English glosses, for part-of-speech evidence. */
  byForm: Map<string, string[]>;
  /**
   * Simplified form → how many of its glosses were verb-marked with "to ".
   *
   * CC-CEDICT carries no part of speech, but it does mark infinitives, and normalising a gloss
   * ("to train" → "train") discards exactly that information. Counting it before discarding is what
   * makes "train" resolvable: 训练 is glossed "to train" and 火车 is glossed "train", so the
   * headword's own part of speech can pick between them.
   */
  verbMarked: Map<string, number>;
}

/** Lines that carry structure rather than a translation. */
const NON_TRANSLATION = /^(CL:|variant of|old variant|see also|see |abbr\.|used in|surname | Taiwan pr\.)/i;

/** Strip the parenthetical and bracketed asides CC-CEDICT attaches to glosses. */
function stripAsides(gloss: string): string {
  return gloss
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turn a raw gloss into a key that can be matched against an English headword, or null when it
 * cannot be one.
 *
 * Only up to two words survive: a gloss like "the emergency number for law enforcement" is a
 * definition, not a translation, and indexing it would never match a headword anyway.
 */
export function normalizeGloss(raw: string): string | null {
  if (NON_TRANSLATION.test(raw.trim())) return null;

  let gloss = stripAsides(raw).toLowerCase().replace(/[.;,]+$/, "").trim();
  // Verbs are listed with the infinitive marker, which no headword carries.
  gloss = gloss.replace(/^to\s+/, "");
  gloss = gloss.replace(/^(a|an|the)\s+/, "");
  if (!gloss) return null;

  // Letters, apostrophes and hyphens, one or two words.
  if (!/^[a-z][a-z'’-]*(?: [a-z][a-z'’-]*)?$/.test(gloss)) return null;
  if (gloss.length < 2) return null;

  return gloss;
}

export function parseCedictLine(line: string): CedictEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  // 傳統 传统 [pinyin] /gloss/gloss/
  const openBracket = trimmed.indexOf("[");
  const closeBracket = trimmed.indexOf("]", openBracket);
  const firstSlash = trimmed.indexOf("/", closeBracket);
  const lastSlash = trimmed.lastIndexOf("/");
  if (openBracket < 0 || closeBracket < 0 || firstSlash < 0 || lastSlash <= firstSlash) return null;

  const head = trimmed.slice(0, openBracket).trim().split(/\s+/);
  if (head.length < 2) return null;

  const glosses = trimmed
    .slice(firstSlash + 1, lastSlash)
    .split("/")
    .map((g) => g.trim())
    .filter(Boolean);

  return {
    traditional: head[0],
    simplified: head[1],
    pinyin: trimmed.slice(openBracket + 1, closeBracket).trim(),
    glosses,
  };
}

export function parseCedict(text: string): { entries: CedictEntry[]; skipped: number } {
  const entries: CedictEntry[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const entry = parseCedictLine(line);
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return { entries, skipped };
}

/**
 * Index the dictionary in reverse.
 *
 * No quality signal is computed here on purpose. An earlier version ranked candidates by how
 * *specific* they were — how few English words a Chinese form translates — and it was exactly
 * backwards for a learner: 犬 and 姹 translate one word each and beat 狗 and 美丽, which are the
 * words anyone would actually use. "Specific" turns out to mean "obscure", so ranking needs a
 * frequency signal instead, supplied by the caller.
 */
/** True when the raw gloss is an infinitive, i.e. CC-CEDICT's only part-of-speech marker. */
export function isVerbMarked(raw: string): boolean {
  return /^to\s+\S/i.test(raw.trim());
}

export function invertGlosses(entries: CedictEntry[]): InvertedGlosses {
  const byGloss = new Map<string, string[]>();
  const genericness = new Map<string, number>();
  const byForm = new Map<string, string[]>();
  const verbMarked = new Map<string, number>();

  for (const entry of entries) {
    const form = entry.simplified;
    const seenForEntry = new Set<string>();

    for (const raw of entry.glosses) {
      const gloss = normalizeGloss(raw);
      if (!gloss) continue;

      const forms = byGloss.get(gloss);
      if (forms) {
        if (!forms.includes(form)) forms.push(form);
      } else {
        byGloss.set(gloss, [form]);
      }

      const formGlosses = byForm.get(form);
      if (formGlosses) {
        if (!formGlosses.includes(gloss)) formGlosses.push(gloss);
      } else {
        byForm.set(form, [gloss]);
      }
      if (isVerbMarked(raw)) verbMarked.set(form, (verbMarked.get(form) ?? 0) + 1);

      // One form counts once per gloss, or an entry with three senses would inflate it.
      if (!seenForEntry.has(gloss)) {
        seenForEntry.add(gloss);
        genericness.set(form, (genericness.get(form) ?? 0) + 1);
      }
    }
  }

  return { byGloss, genericness, byForm, verbMarked };
}

export type PartOfSpeech = "verb" | "noun" | "adjective" | "adverb";

export interface PosContext {
  /** The inverted dictionary, for a form's own glosses. */
  inverted: InvertedGlosses;
  /** English lemma → its parts of speech, from our own vocabulary. */
  vocabPos: Map<string, string[]>;
}

/**
 * Estimate the part of speech of a Chinese form, from evidence rather than from a tag.
 *
 * Two sources, because neither is complete:
 *
 *   the infinitive marker   "to train" is a verb, "train" is not. CC-CEDICT's only explicit signal.
 *   our own vocabulary      if a gloss is itself a headword we hold, we know its part of speech.
 *
 * Returns null rather than guessing when the evidence is thin — an unlabelled gloss is honest, a
 * wrong label is not.
 */
export function estimateTermPos(
  form: string,
  context: PosContext,
): { pos: PartOfSpeech | null; votes: Record<PartOfSpeech, number> } {
  const votes: Record<PartOfSpeech, number> = { verb: 0, noun: 0, adjective: 0, adverb: 0 };
  const glosses = context.inverted.byForm.get(form) ?? [];

  for (const gloss of glosses) {
    for (const pos of context.vocabPos.get(gloss) ?? []) {
      if (pos in votes) votes[pos as PartOfSpeech] += 1;
    }
  }

  // The infinitive marker is stronger evidence than a gloss we happen to hold, because it is a
  // statement about this entry rather than about the English word in general.
  const marked = context.inverted.verbMarked.get(form) ?? 0;
  if (glosses.length > 0 && marked / glosses.length >= 0.5) votes.verb += 2;

  const ranked = (Object.entries(votes) as Array<[PartOfSpeech, number]>).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return { pos: null, votes };

  // Require a clear winner: a form with one noun vote and one verb vote is not decidable, and
  // labelling it would narrow the search in the wrong direction.
  if (ranked[0][1] === ranked[1][1]) return { pos: null, votes };
  return { pos: ranked[0][0], votes };
}

/**
 * Function and deictic words that CC-CEDICT lists as glosses of ordinary content words.
 *
 * 那 ("that") is a gloss of "beautiful", 药 ("medicine") of "poison". They are extremely frequent,
 * so frequency alone puts them first, and they are never the lexical translation a learner wants.
 * This is a guard, not a part-of-speech model: CC-CEDICT carries no part of speech at all.
 */
const FUNCTION_WORDS = new Set(
  ("那 这 是 有 在 就 都 也 很 个 着 了 过 和 与 而 但 却 便 则 之 其 此 该 把 被 让 使 给 对 从 到 " +
    "向 往 由 因 为 所 以 於 于 啊 吧 呢 吗 的 地 得").split(" "),
);

/** How hard specificity is weighed against frequency. See `scoreChineseCandidate`. */
export const GENERICNESS_PENALTY = 0.8;

/** Penalty applied to a function word, in Zipf units. */
export const FUNCTION_WORD_PENALTY = 3;

export interface CandidateSignals {
  /** Chinese frequency, from wordfreq. Higher is more common. */
  zipf: Map<string, number>;
  /** How many distinct English glosses each Chinese form translates. */
  genericness: Map<string, number>;
}

/**
 * Score one candidate gloss for an English headword.
 *
 *     score = zipf − 0.8·ln(genericness) − (function word ? 3 : 0)
 *
 * Neither signal works alone, and both failure modes were observed on the real dictionary:
 *
 *   frequency only      "beautiful" → 那 ("that", Zipf 6.0) and "poison" → 药 ("medicine")
 *   specificity only    "dog" → 犬 and "beautiful" → 姹, because translating exactly one English
 *                       word is also what makes a form obscure
 *
 * Combining them, the penalty curve was chosen by measuring a 23-word sample at α = 0.8, 1.0 and
 * 1.3; 0.8 was the only setting that fixed both disasters while keeping 猫 for "cat" and 工作 for
 * "work". It is a heuristic, not a sense disambiguator: ambiguous verbs are still the weak spot
 * ("run" → 运行 rather than 跑), which is why several candidates are stored and only the first is
 * shown.
 */
export function scoreChineseCandidate(text: string, signals: CandidateSignals): number {
  const zipf = signals.zipf.get(text) ?? 0;
  const generic = Math.max(1, signals.genericness.get(text) ?? 1);
  const guard = FUNCTION_WORDS.has(text) ? FUNCTION_WORD_PENALTY : 0;
  return zipf - GENERICNESS_PENALTY * Math.log(generic) - guard;
}

/** How much a candidate gains for matching the headword's part of speech, in Zipf units. */
export const POS_MATCH_BONUS = 1.5;

export interface RankOptions {
  /** The headword's part of speech, from the vocabulary entry being glossed. */
  preferPos?: string;
  /** Estimated part of speech of a candidate term. */
  termPosOf?: (form: string) => PartOfSpeech | null;
  posBonus?: number;
}

/**
 * Order the Chinese candidates for one English headword, best first.
 *
 * The score is frequency adjusted for specificity (`scoreChineseCandidate`), plus a bonus when the
 * candidate's estimated part of speech matches the headword's. That last term is what resolves the
 * case this ranking exists for: `train/verb` must rank 训练 ("to train") above 火车 ("railway
 * train"), which frequency alone puts first because the noun reading is more common overall.
 *
 * Candidates with no frequency score sort after those that have one, then by length — a short form
 * is more likely to be the everyday word than a long technical one.
 */
export function rankChineseCandidates(
  candidates: string[],
  signals: CandidateSignals,
  options: RankOptions = {},
): string[] {
  const bonus = options.posBonus ?? POS_MATCH_BONUS;
  const score = (form: string) => {
    let value = scoreChineseCandidate(form, signals);
    if (options.preferPos && options.termPosOf) {
      const pos = options.termPosOf(form);
      // Only a positive match earns a bonus. An unknown part of speech is not evidence against a
      // candidate, or the roughly half of forms with no evidence would all be pushed to the bottom.
      if (pos && pos === options.preferPos) value += bonus;
    }
    return value;
  };

  return [...candidates].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    const za = signals.zipf.get(a) ?? 0;
    const zb = signals.zipf.get(b) ?? 0;
    if (za !== zb) return zb - za;
    if (a.length !== b.length) return a.length - b.length;
    return candidates.indexOf(a) - candidates.indexOf(b);
  });
}
