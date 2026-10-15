/**
 * Collect the words we need frequency scores for, so `wordfreq` can be queried in one pass.
 *
 *   npm run export:frequency
 *
 * Reads the vocabulary already imported into MongoDB and writes one word per line to
 * `data/<lang>/frequency-words.txt`. The Python exporter then turns that into a Zipf table,
 * which `import-frequency` reads back.
 *
 * The round trip through a file is deliberate: wordfreq is a Python package with no Node
 * equivalent, and keeping the boundary at a plain word list means neither side needs to know
 * anything about the other's data model.
 */

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { runIfEntry } from "../run";

export const DATA = path.join(process.cwd(), "data");

export function wordsPath(lang: string): string {
  return path.join(DATA, lang, "frequency-words.txt");
}

export function zipfPath(lang: string): string {
  return path.join(DATA, lang, "wordfreq-zipf.json");
}

async function collect(lang: "en" | "de"): Promise<number> {
  await mkdir(path.join(DATA, lang), { recursive: true });
  const out = createWriteStream(wordsPath(lang));

  // Both the lemma and every surface form: a form can be far more frequent than its lemma
  // ("ist" vs "sein"), and difficulty should reflect what the learner actually meets.
  const seen = new Set<string>();
  const write = (word: string) => {
    const key = lemmaKeyOf(word);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.write(`${key}\n`);
  };

  const cursor = Word.find({ targetLang: lang }).select("lemmaKey surfaceForms").lean().cursor();
  let docs = 0;
  for await (const doc of cursor) {
    docs += 1;
    write(doc.lemmaKey);
    for (const form of doc.surfaceForms ?? []) write(form);
    if (docs % 50_000 === 0) process.stdout.write(`\r  scanning… ${docs}`);
  }
  process.stdout.write(`\r  scanned ${docs} ${lang} words    \n`);

  await new Promise<void>((resolve) => out.end(resolve));
  await writeFile(
    path.join(DATA, lang, "frequency-words.meta.json"),
    JSON.stringify({ lang, docs, uniqueWords: seen.size, generatedAt: new Date().toISOString() }, null, 2),
  );
  return seen.size;
}

async function main() {
  await connectDB();
  console.log("Collecting words for frequency export");
  console.log("────────────────────────────────────");
  for (const lang of ["en", "de"] as const) {
    const unique = await collect(lang);
    console.log(`  ${lang}: ${unique} unique words → ${path.relative(process.cwd(), wordsPath(lang))}`);
  }
  console.log("\nNext: the Python exporter (see npm run export:frequency)");
}

runIfEntry(import.meta.url, main);
