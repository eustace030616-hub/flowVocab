/**
 * What still depends on the legacy dictionary?
 *
 * Repacks every passage with the legacy tables emptied and reports what came out. The point is to find the
 * dependencies that no amount of reading finds — a gloss that only the old table had, a lemma that only
 * `inflections` resolved, a difficulty that only the `words` column supplied.
 *
 * Run it on a copy, never on the live database — and make the copy with SQLite, not `cp`: the database
 * runs in WAL mode, so recent writes live in a side file that a plain copy of the main file does not
 * include. That cost me a whole round of chasing a coverage number that was measured against a stale
 * database.
 *
 *   sqlite3 data/flowwing.sqlite3 "VACUUM INTO 'data/legacy-audit.sqlite3'"
 *   FLOWWING_DB=data/legacy-audit.sqlite3 npm run audit:legacy
 */
import { all, get, openDatabase, run } from "../../lib/store/db";
import { packParagraph, packageFor } from "../../lib/content/pack";

async function main() {
  openDatabase();

  // 1. Empty what LEGACY.md says should go.
  run("DELETE FROM inflections");
  run("DELETE FROM separations");
  run("DELETE FROM glosses");
  run("UPDATE words SET difficulty = -1");
  console.log("  emptied: inflections, separations, glosses · words.difficulty = -1");

  // 2. Repack every passage through the new stack.
  const paragraphs = all<{ id: string; targetLang: string }>("SELECT id, targetLang FROM paragraphs");
  let words = 0;
  let glossed = 0;
  let lemmas = new Set<string>();
  const missing = new Map<string, number>();
  let withDifficulty = 0;
  let chinese = 0;
  let failed = 0;

  for (const paragraph of paragraphs) {
    try {
      await packParagraph(paragraph.id);
    } catch {
      failed += 1;
      continue;
    }
    const pack = packageFor(paragraph.id);
    if (!pack) continue;
    for (const [key, entry] of Object.entries(pack.vocabulary)) {
      words += 1;
      if (!entry.gloss) missing.set(key, (missing.get(key) ?? 0) + 1);
      if (entry.gloss) {
        glossed += 1;
        if (/[\u4e00-\u9fff]/.test(entry.gloss)) chinese += 1;
      }
      if (entry.lemma) lemmas.add(entry.lemma);
      if (typeof entry.difficulty === "number" && entry.difficulty >= 0) withDifficulty += 1;
    }
  }

  const pct = (n: number) => `${Math.round((n / Math.max(1, words)) * 100)}%`;
  console.log(`\n  passages repacked: ${paragraphs.length - failed}/${paragraphs.length} (${failed} failed)`);
  console.log(`  distinct words:    ${words}`);
  console.log(`  with a gloss:      ${glossed} (${pct(glossed)})`);
  console.log(`  with Chinese:      ${chinese} (${pct(chinese)})`);
  console.log(`  distinct lemmas:   ${lemmas.size}`);

  // Which words are actually being asked for, and where they exist at all. A word absent from the book
  // needs adding; a word present without a translation needs a gloss.
  const wanted = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const inBook = all<{ lemmaKey: string; translation: string | null }>(
    `SELECT lemmaKey, translation FROM wordbook WHERE targetLang = 'de' AND lemmaKey IN (${wanted.map(() => "?").join(",")})`,
    ...wanted.map(([key]) => key),
  );
  const book = new Map(inBook.map((row) => [row.lemmaKey, row.translation]));
  console.log(`\n  top ${wanted.length} missing words (${missing.size} distinct):`);
  for (const [key, count] of wanted) {
    const state = book.has(key) ? (book.get(key) ? "in book, glossed" : "in book, NO gloss") : "not in book";
    console.log(`   ${key.padEnd(18)} ${String(count).padStart(3)}×  ${state}`);
  }
  console.log(`  with difficulty:   ${withDifficulty} (${pct(withDifficulty)})`);
}

void main();
