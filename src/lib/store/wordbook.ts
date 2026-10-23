/**
 * The word book: level, translation and inflection, in one small table.
 *
 * This is what replaces the dictionary's three jobs. It is deliberately tiny — a few thousand curated
 * words rather than 290,000 derived ones — and every row records where each field came from, because
 * "level: B1" means something different when it comes from a Goethe list than when it comes from a
 * frequency table.
 */
import { all } from "./db";
import { glossLangFor, type TargetLang } from "../lang";

export interface WordbookEntry {
  lemmaKey: string;
  word: string;
  article: string | null;
  level: string | null;
  levelSource: string | null;
  forms: string[];
  translation: string | null;
  translationSource: string | null;
}

/** Japanese-style batch: SQLite's parameter limit is 999, so keys are asked for in chunks. */
function chunks<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export function wordbookEntries(targetLang: TargetLang, keys: string[]): Map<string, WordbookEntry> {
  const found = new Map<string, WordbookEntry>();
  const unique = [...new Set(keys)];
  for (const batch of chunks(unique)) {
    if (batch.length === 0) continue;
    const rows = all<{
      lemmaKey: string;
      word: string;
      article: string | null;
      level: string | null;
      levelSource: string | null;
      forms: string | null;
      translation: string | null;
      translationSource: string | null;
    }>(
      `SELECT lemmaKey, word, article, level, levelSource, forms, translation, translationSource
         FROM wordbook WHERE targetLang = ? AND lemmaKey IN (${batch.map(() => "?").join(",")})`,
      targetLang,
      ...batch,
    );
    for (const row of rows) {
      let forms: string[] = [];
      try {
        forms = row.forms ? (JSON.parse(row.forms) as string[]) : [];
      } catch {
        forms = [];
      }
      found.set(row.lemmaKey, { ...row, forms });
    }
  }
  return found;
}

/**
 * Translations for these lemmas, in the language the reader needs.
 *
 * The word book is English-glossed: it was built from German-learning material. A Chinese reader falls
 * back to the old gloss table, which is why this returns only what it actually has.
 */
export function wordbookGlosses(
  targetLang: TargetLang,
  glossLang: "en" | "zh",
  keys: string[],
): Map<string, { text: string; source: string }> {
  // The German book glosses in English and the English book in Chinese, so a book answers only for the
  // gloss language its own track needs.
  if (glossLang !== glossLangFor(targetLang)) return new Map();
  const entries = wordbookEntries(targetLang, keys);
  const out = new Map<string, { text: string; source: string }>();
  for (const [key, entry] of entries) {
    if (entry.translation) out.set(key, { text: entry.translation, source: entry.translationSource ?? "wordbook" });
  }
  return out;
}

/** How many words of each level the book holds — the shape of the book, for reports. */
export function wordbookShape(targetLang: TargetLang): Array<{ level: string | null; n: number }> {
  return all<{ level: string | null; n: number }>(
    "SELECT level, COUNT(*) AS n FROM wordbook WHERE targetLang = ? GROUP BY level ORDER BY level",
    targetLang,
  );
}
