/**
 * Reading glosses for a set of headwords.
 *
 * Glosses live in their own collection, one document per translation per source (see
 * models/Gloss.ts), so a read has to pick one to show. Within a language the lowest `rank` wins,
 * and rank is a *cross-source* preference order: curated content claims 0, imported dictionaries
 * start at 1 so a hand-written gloss outranks a dump. The source travels with the text so the
 * interface can attribute what it shows.
 *
 * Because sources are independent, a headword may have glosses from several of them at once.
 * This returns one, deliberately: the interface shows a translation, not a concordance. The
 * others remain queryable for the review mode and for cross-source comparison.
 */

import { Gloss } from "../../models/Gloss";
import type { GlossLang, TargetLang } from "../lang";

export interface GlossView {
  text: string;
  source: string;
  license: string;
  generated: boolean;
  rank: number;
}

export async function glossesFor(
  targetLang: TargetLang,
  lang: GlossLang,
  lemmaKeys: string[],
): Promise<Map<string, GlossView>> {
  const map = new Map<string, GlossView>();
  if (lemmaKeys.length === 0) return map;

  const rows = await Gloss.find({ targetLang, lang, lemmaKey: { $in: lemmaKeys } })
    // Deterministic on ties: a stable source order beats whatever Mongo happens to return.
    .sort({ rank: 1, source: 1, text: 1 })
    .select("lemmaKey text source license generated rank")
    .lean();

  for (const row of rows) {
    // Sorted by rank, so the first row for a headword is the preferred gloss.
    if (map.has(row.lemmaKey)) continue;
    map.set(row.lemmaKey, {
      text: row.text,
      source: row.source,
      license: row.license,
      generated: row.generated,
      rank: row.rank,
    });
  }
  return map;
}

/** Every gloss for one headword, for a detail view that wants to show disagreements. */
export async function allGlossesFor(
  targetLang: TargetLang,
  lemmaKey: string,
): Promise<Array<GlossView & { lang: GlossLang }>> {
  const rows = await Gloss.find({ targetLang, lemmaKey })
    .sort({ lang: 1, rank: 1 })
    .select("lang text source license generated rank")
    .lean();

  return rows.map((row) => ({
    lang: row.lang,
    text: row.text,
    source: row.source,
    license: row.license,
    generated: row.generated,
    rank: row.rank,
  }));
}
