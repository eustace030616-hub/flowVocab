/**
 * LEGACY(learner/glosses)
 *
 * Per-lemma translations from the derived gloss table. The word book is consulted first for
 *  English; this remains for Chinese, which the book does not carry, and for words it lacks.
 */
/**
 * Reading glosses for a set of headwords.
 *
 * Glosses live in their own collection, one document per translation per source (see
 * models/Gloss.ts), so a read has to pick one to show. Within a language the lowest `rank` wins,
 * and rank is a *cross-source* preference order: curated content claims 0, imported dictionaries
 * start at 1 so a hand-written gloss outranks a dump. The source travels with the text so the
 * interface can attribute what it shows.
 *
 * Glosses are keyed by `(lemmaKey, pos)`, not by the lemma alone. That matters more than it sounds:
 * "train" is a noun entry and a verb entry, and a single flat gloss list gave the verb reading
 * 火车 (railway train). A part of speech is part of the identity of a meaning.
 */

import { glossesByKeys } from "../store/dictionary";
import type { GlossLang, TargetLang } from "../lang";

export interface GlossView {
  text: string;
  source: string;
  license: string;
  generated: boolean;
  rank: number;
  /** Part of speech this gloss is attached to. */
  pos: string;
  /** Estimated part of speech of the gloss term itself, when it could be derived. */
  termPos: string | null;
}

/** Key for a (headword, part of speech) pair. */
export function glossKey(lemmaKey: string, pos: string): string {
  return `${lemmaKey}\u0000${pos}`;
}

export interface GlossQuery {
  lemmaKey: string;
  pos: string;
}

/**
 * Look up the best gloss for a headword.
 *
 * Falls back to the unclassified bucket (`pos: ""`) when nothing matches the exact part of speech,
 * which is what sources without a part of speech — and imports that ran before this existed —
 * produce.
 */
export function pickGloss(
  map: Map<string, GlossView>,
  lemmaKey: string,
  pos: string,
): GlossView | null {
  return map.get(glossKey(lemmaKey, pos)) ?? map.get(glossKey(lemmaKey, "")) ?? null;
}

export async function glossesFor(
  targetLang: TargetLang,
  lang: GlossLang,
  queries: GlossQuery[],
): Promise<Map<string, GlossView>> {
  const map = new Map<string, GlossView>();
  if (queries.length === 0) return map;

  const lemmaKeys = [...new Set(queries.map((q) => q.lemmaKey))];
  // Sorted by rank, source, text in SQL — deterministic on ties, which beats whatever order a
  // storage engine happens to return.
  const rows = glossesByKeys(targetLang, lang, lemmaKeys);

  for (const row of rows) {
    // Sorted by rank, so the first row for a key is the preferred gloss.
    const key = glossKey(row.lemmaKey, row.pos ?? "");
    if (map.has(key)) continue;
    map.set(key, {
      text: row.text,
      source: row.source,
      license: row.license,
      generated: row.generated,
      rank: row.rank,
      pos: row.pos ?? "",
      termPos: row.termPos ?? null,
    });
  }
  return map;
}

/**
 * Every gloss for each of several headwords, grouped by lemma and ordered for display.
 *
 * Used where a running-text token carries no part of speech, which is the normal case: nothing in
 * the tokenizer knows that "well-trained" is a verb. Rather than let whichever database row is
 * returned first decide the reading — it picked the noun, and glossed a verb as 火车 — the caller
 * gets all the readings, labelled, and the interface shows them side by side.
 */
export async function glossesByLemma(
  targetLang: TargetLang,
  lang: GlossLang,
  lemmaKeys: string[],
): Promise<Map<string, GlossView[]>> {
  const map = new Map<string, GlossView[]>();
  if (lemmaKeys.length === 0) return map;

  const rows = glossesByKeys(targetLang, lang, lemmaKeys);

  for (const row of rows) {
    const view: GlossView = {
      text: row.text,
      source: row.source,
      license: row.license,
      generated: row.generated,
      rank: row.rank,
      pos: row.pos ?? "",
      termPos: row.termPos ?? null,
    };
    const list = map.get(row.lemmaKey);
    if (list) list.push(view);
    else map.set(row.lemmaKey, [view]);
  }

  // Best first, then a stable order so the display does not shuffle between requests.
  for (const list of map.values()) {
    list.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.pos.localeCompare(b.pos) ||
        a.source.localeCompare(b.source) ||
        a.text.localeCompare(b.text),
    );
  }
  return map;
}

/** Every gloss for one headword, across parts of speech — so disagreements stay visible. */
export async function allGlossesFor(
  targetLang: TargetLang,
  lemmaKey: string,
): Promise<Array<GlossView & { lang: GlossLang }>> {
  // Every part of speech and both gloss languages, so disagreements stay visible.
  const rows = [
    ...glossesByKeys(targetLang, "en", [lemmaKey]),
    ...glossesByKeys(targetLang, "zh", [lemmaKey]),
  ].sort(
    (a, b) => a.pos.localeCompare(b.pos) || a.lang.localeCompare(b.lang) || a.rank - b.rank,
  );

  return rows.map((row) => ({
    lang: row.lang,
    pos: row.pos ?? "",
    termPos: row.termPos ?? null,
    text: row.text,
    source: row.source,
    license: row.license,
    generated: row.generated,
    rank: row.rank,
  }));
}
