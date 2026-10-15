/**
 * Building a lemma lexicon for tokenization.
 *
 * Lemmatisation is only as good as the lexicon behind it — rules alone turn "gelesen" into a
 * guess. But the client cannot hold a 281,207-lemma German lexicon, so tokenization happens on
 * the **server** and the client renders the spans it is given.
 *
 * That is a correctness decision, not just a performance one: if the client lemmatised
 * independently, the span it rendered and the lemma the server recorded could disagree, and a
 * learner's mark would attach to a word they did not click.
 */

import type { Types } from "mongoose";

import { Word } from "../../models/Word";
import type { TargetLang } from "../lang";
import { tokenize, wordSpans, type LemmaLookup, type Span } from "../tokenize";
import { candidatesFor } from "../tokenize/rules";

/**
 * Build a lookup over the lemmas a specific text can plausibly resolve to.
 *
 * Generates every candidate form for every surface in the text, then asks the database once
 * which of them exist. One query per paragraph, regardless of token count.
 */
export async function buildLexicon(
  targetLang: TargetLang,
  surfaces: string[],
): Promise<LemmaLookup> {
  const candidates = new Set<string>();
  for (const surface of surfaces) {
    for (const candidate of candidatesFor(surface, targetLang)) candidates.add(candidate);
  }
  if (candidates.size === 0) return () => false;

  const found = await Word.find({
    targetLang,
    lemmaKey: { $in: [...candidates] },
  })
    .select("lemmaKey")
    .lean();

  const known = new Set(found.map((w) => w.lemmaKey));
  return (candidate: string) => known.has(candidate);
}

/**
 * Tokenize a text against the database lexicon.
 *
 * Spans carry `matched`, which records whether a lexicon confirmed the lemma. Callers must treat
 * an unmatched lemma as a best-effort guess rather than ground truth.
 */
export async function tokenizeWithLexicon(
  text: string,
  targetLang: TargetLang,
): Promise<Span[]> {
  const scratch = tokenize(text, targetLang);
  const surfaces = wordSpans(scratch).map((s) => s.surface);
  const lookup = await buildLexicon(targetLang, surfaces);
  return tokenize(text, targetLang, { lookup });
}

export interface LexiconEntry {
  _id: Types.ObjectId;
  lemma: string;
  lemmaKey: string;
}

/** Resolve the Word documents behind a set of spans, keyed by lemmaKey (first match wins). */
export async function wordsForSpans(
  targetLang: TargetLang,
  spans: Span[],
): Promise<Map<string, LexiconEntry>> {
  const keys = [...new Set(wordSpans(spans).map((s) => s.lemmaKey))];
  if (keys.length === 0) return new Map();

  const docs = await Word.find({ targetLang, lemmaKey: { $in: keys } })
    .select("_id lemma lemmaKey")
    .lean();

  const map = new Map<string, LexiconEntry>();
  for (const doc of docs) {
    if (!map.has(doc.lemmaKey)) {
      map.set(doc.lemmaKey, {
        _id: doc._id,
        lemma: doc.lemma,
        lemmaKey: doc.lemmaKey,
      });
    }
  }
  return map;
}
