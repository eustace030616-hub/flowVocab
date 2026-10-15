/**
 * Parser for kaikki.org's German Wiktextract extract.
 *
 * Licence: CC BY-SA 4.0 + GFDL, share-alike, so these glosses live in their own `Gloss` documents
 * alongside ding and CC-CEDICT.
 *
 * Why this source exists: ding is a phrase dictionary with a headword inventory that is thin on
 * verbs — it has no entry for "brauchen" at all, though the word appears in 104 of its example
 * lists — while Wiktionary defines it plainly ("to need, to be in need of, to require"). This layer
 * fills the gaps ding leaves rather than replacing it, which is why it ranks behind it.
 *
 * Nearly half of the entries are inflected forms whose gloss is "inflection of …", so the
 * cross-reference filter is not a nicety: without it the dictionary would teach "braucht" as a
 * meaning rather than a form.
 *
 * Pure, so the filtering and the part-of-speech mapping can be tested against the real file.
 */

import type { TargetLang } from "../../lib/lang";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";

/** kaikki's part-of-speech vocabulary, mapped onto ours. Unmapped values are not lexical entries. */
const POS_MAP: Record<string, string> = {
  noun: "noun",
  verb: "verb",
  adj: "adjective",
  adv: "adverb",
  prep: "preposition",
  conj: "conjunction",
  pron: "pronoun",
  num: "numeral",
  intj: "interjection",
  particle: "particle",
  article: "article",
};

export interface KaikkiEntry {
  word: string;
  lemmaKey: string;
  lang: TargetLang;
  pos: string;
  /** English glosses, in the order the dictionary lists them. Empty for an inflected form. */
  glosses: string[];
  /**
   * The citation form this entry is a shape of, when it is one — `liest` → `lesen`.
   *
   * Wiktionary states this structurally (`form_of`, plus a `form-of` tag), which is far more
   * reliable than inferring it from a gloss like "second/third-person singular present of lesen".
   * 72% of the German entries carry it, and it is what makes an inflected word resolve to the word
   * that actually has a translation.
   */
  formOf: string | null;
}

export function mapKaikkiPos(pos: string): string | null {
  return POS_MAP[pos] ?? null;
}

/**
 * True when a gloss describes a form rather than a meaning.
 *
 * These are the openings Wiktionary uses for inflections, case forms and abbreviations. They are
 * the majority of German entries, so an unfiltered import would attach "inflection of brauchen" to
 * any inflected form that happens to be a lemma elsewhere.
 */
const CROSS_REFERENCE =
  /^(first|second|third|1st|2nd|3rd)[- ]|^(inflection of|plural of|genitive|dative|nominative|accusative|comparative of|superlative of|past of|participle of|form of|abbreviation of|alternative form|alternative spelling|misspelling|see |diminutive of|feminine of|masculine of|neuter of)\b/i;

export function isCrossReferenceGloss(gloss: string): boolean {
  return CROSS_REFERENCE.test(gloss.trim());
}

/** Tidy a gloss for display: drop asides, collapse whitespace, trim trailing punctuation. */
export function cleanGloss(gloss: string, maxLength = 120): string | null {
  const cleaned = gloss
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.;,]+$/, "")
    .trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  return cleaned;
}

interface RawKaikki {
  word?: unknown;
  lang?: unknown;
  pos?: unknown;
  senses?: Array<{
    glosses?: string[];
    form_of?: Array<{ word?: string }>;
    tags?: string[];
  }>;
}

/**
 * Parse one JSONL line, or null when it is not a usable German gloss entry.
 *
 * Only the first gloss of each sense is taken: later ones are usually a second wording of the same
 * sense, and the first is the one the dictionary leads with.
 */
export function parseKaikkiEntry(line: string, maxGlosses = 3): KaikkiEntry | null {
  if (!line.trim()) return null;

  let raw: RawKaikki;
  try {
    raw = JSON.parse(line) as RawKaikki;
  } catch {
    return null;
  }

  const word = typeof raw.word === "string" ? raw.word : "";
  if (!word) return null;
  if (typeof raw.lang === "string" && raw.lang !== "German") return null;

  const pos = mapKaikkiPos(typeof raw.pos === "string" ? raw.pos : "");
  if (!pos) return null;

  const senses = raw.senses ?? [];

  // An inflected form states its base. Its "gloss" describes the shape, not a meaning, so the
  // entry contributes a form→lemma mapping and no translations at all.
  const formOfSense = senses.find((sense) => (sense.form_of ?? []).length > 0);
  const statedBase = formOfSense?.form_of?.[0]?.word;
  if (typeof statedBase === "string" && statedBase.trim()) {
    return {
      word,
      lemmaKey: lemmaKeyOf(word),
      lang: "de",
      pos,
      glosses: [],
      formOf: statedBase.trim(),
    };
  }

  const glosses: string[] = [];
  for (const sense of senses) {
    const first = (sense.glosses ?? [])[0];
    if (typeof first !== "string") continue;
    if (isCrossReferenceGloss(first)) continue;
    const cleaned = cleanGloss(first);
    if (cleaned && !glosses.includes(cleaned)) glosses.push(cleaned);
    if (glosses.length >= maxGlosses) break;
  }
  if (glosses.length === 0) return null;

  return { word, lemmaKey: lemmaKeyOf(word), lang: "de", pos, glosses, formOf: null };
}
