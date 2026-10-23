/**
 * Load the word book built by `tools/dictionary/build_wordbook.py` into the database.
 *
 *   npm run dict:seed -- /tmp/wordbook.json
 *
 * The file is not in the repository: it derives from third-party material whose conditions are recorded
 * in the builder. This only reads it.
 */
import { readFile } from "node:fs/promises";

import { nowMs, openDatabase, run } from "../../lib/store/db";

const ARTICLE: Record<string, string> = { m: "der", f: "die", n: "das", "m.": "der", "f.": "die", "n.": "das" };

function normaliseArticle(article: string | null): string | null {
  if (!article) return null;
  return ARTICLE[article.trim().toLowerCase()] ?? article;
}

interface Entry {
  word: string;
  article: string | null;
  level: string | null;
  levelSource: string | null;
  forms: string[];
  translation: string | null;
  translationSource: string | null;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? "/tmp/wordbook.json";
  openDatabase();
  const book = JSON.parse(await readFile(path, "utf8")) as Record<string, Entry>;
  const at = nowMs();

  run("DELETE FROM wordbook");
  let written = 0;
  for (const [key, entry] of Object.entries(book)) {
    run(
      `INSERT OR REPLACE INTO wordbook
         (lemmaKey, word, article, level, levelSource, forms, translation, translationSource, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      key,
      entry.word,
      normaliseArticle(entry.article),
      entry.level,
      entry.levelSource,
      JSON.stringify(entry.forms ?? []),
      entry.translation,
      entry.translationSource,
      at,
    );
    written += 1;
  }
  console.log(`  wordbook: ${written} entries from ${path}`);
}

void main();
