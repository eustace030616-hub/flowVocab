/**
 * The word book as the writer's vocabulary source.
 *
 * Generation used to sample `words` by difficulty and gloss from `glosses`. Both are the legacy stack: the
 * book carries a curated level and a translation per word, which is the same information in one place and
 * in the units the rest of the pipeline now uses.
 */
import { all } from "../store/db";
import { CEFR_LEVELS, type CefrLevel, type TargetLang } from "../lang";
import { difficultyFromLevel } from "../difficulty";

export interface BookItem {
  word: string;
  gloss: string | null;
  level: string | null;
}

function levelsUpTo(level: CefrLevel): string[] {
  const index = CEFR_LEVELS.indexOf(level);
  return CEFR_LEVELS.slice(0, index < 0 ? 1 : index + 1);
}

/**
 * Words for the prompt: a broad sample at or below the level, and a small set exactly at it.
 *
 * Only words with a translation are eligible, because a word the reader cannot have glossed is a word the
 * prompt cannot ask them to understand.
 */
export function sampleBook(targetLang: TargetLang, level: CefrLevel, size: number): { core: BookItem[]; target: BookItem[] } {
  const upTo = levelsUpTo(level);
  const placeholders = upTo.map(() => "?").join(",");
  const core = all<BookItem>(
    `SELECT word, translation AS gloss, level FROM wordbook
      WHERE targetLang = ? AND translation IS NOT NULL AND level IN (${placeholders})
      ORDER BY RANDOM() LIMIT ?`,
    targetLang,
    ...upTo,
    size,
  );
  const target = all<BookItem>(
    `SELECT word, translation AS gloss, level FROM wordbook
      WHERE targetLang = ? AND translation IS NOT NULL AND level = ?
      ORDER BY RANDOM() LIMIT 8`,
    targetLang,
    level,
  );
  return { core, target };
}

/** Difficulty per lemma, from the book's level. Absent words simply have no difficulty. */
export function bookDifficulty(targetLang: TargetLang, keys: string[]): Map<string, number> {
  const unique = [...new Set(keys)];
  const out = new Map<string, number>();
  if (unique.length === 0) return out;
  const rows = all<{ lemmaKey: string; level: string | null }>(
    `SELECT lemmaKey, level FROM wordbook
      WHERE targetLang = ? AND lemmaKey IN (${unique.map(() => "?").join(",")})`,
    targetLang,
    ...unique,
  );
  for (const row of rows) {
    const difficulty = difficultyFromLevel(row.level);
    if (difficulty !== null) out.set(row.lemmaKey, difficulty);
  }
  return out;
}

/** Keep the model's topic proposals the book agrees are at or below the ceiling. */
export function filterTopicWords(
  targetLang: TargetLang,
  candidates: string[],
  ceiling: number,
): BookItem[] {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return [];
  const rows = all<{ lemmaKey: string; word: string; translation: string | null; level: string | null }>(
    `SELECT lemmaKey, word, translation, level FROM wordbook
      WHERE targetLang = ? AND translation IS NOT NULL AND lemmaKey IN (${unique.map(() => "?").join(",")})`,
    targetLang,
    ...unique,
  );
  return rows
    .filter((row) => {
      const difficulty = difficultyFromLevel(row.level);
      return difficulty !== null && difficulty <= ceiling;
    })
    .map((row) => ({ word: row.word, gloss: row.translation, level: row.level }));
}
