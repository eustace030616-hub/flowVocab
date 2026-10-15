/**
 * Attach `wordfreq` Zipf scores to the vocabulary.
 *
 *   npm run import:frequency
 *
 * Reads the table produced by `collect-frequency-words` + `wordfreq_export.py` and writes
 * `Word.frequency.wordfreq`. It only *attaches evidence* — turning that evidence into a
 * difficulty score is a separate step (`npm run recompute:difficulty`), so the curve can be
 * re-fitted without re-importing anything.
 *
 * A lemma is scored by the **most frequent of its forms**, not by the lemma spelling alone.
 * Learners meet inflected forms ("ist", "gelesen"), and those carry the frequency signal — the
 * citation form can be comparatively rare even for a very common word. Without this, "sein"
 * would be scored on "sein" while the learner meets "ist" a hundred times as often.
 *
 * A word wordfreq has never seen scores 0, which means "no evidence" rather than "extremely
 * rare". It is stored as absent, not as zero, so nothing downstream can mistake the two.
 */

import { existsSync, readFileSync } from "node:fs";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable } from "../../lib/licence/datasets";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { zipfPath } from "./collect-frequency-words";
import { runIfEntry } from "../run";

interface ZipfFile {
  lang: string;
  source: string;
  license: string;
  words: number;
  known: number;
  zipf: Record<string, number>;
}

interface Stats {
  considered: number;
  scored: number;
  viaForm: number;
  unseen: number;
}

async function importLang(lang: "en" | "de"): Promise<Stats> {
  const file = zipfPath(lang);
  if (!existsSync(file)) throw new Error(`missing ${file}\nRun: npm run export:frequency`);

  const data = JSON.parse(readFileSync(file, "utf8")) as ZipfFile;
  const zipf = new Map(Object.entries(data.zipf));
  console.log(`  ${lang}: ${zipf.size} scored forms loaded`);

  const stats: Stats = { considered: 0, scored: 0, viaForm: 0, unseen: 0 };
  const cursor = Word.find({ targetLang: lang }).select("lemmaKey surfaceForms").lean().cursor();

  let ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];

  for await (const doc of cursor) {
    stats.considered += 1;

    const own = zipf.get(doc.lemmaKey) ?? 0;
    let best = own;
    for (const form of doc.surfaceForms ?? []) {
      const value = zipf.get(lemmaKeyOf(form)) ?? 0;
      if (value > best) best = value;
    }

    if (best <= 0) {
      stats.unseen += 1;
      // Explicitly clear any stale score rather than leaving a previous run's value.
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $unset: { "frequency.wordfreq": "" } } } });
    } else {
      stats.scored += 1;
      if (best > own) stats.viaForm += 1;
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { "frequency.wordfreq": best } } } });
    }

    if (ops.length >= 2000) {
      await Word.bulkWrite(ops, { ordered: false });
      ops = [];
      process.stdout.write(`\r  ${lang}: ${stats.considered.toLocaleString()} considered`);
    }
  }
  if (ops.length) await Word.bulkWrite(ops, { ordered: false });
  process.stdout.write("\n");
  return stats;
}

async function main() {
  assertShippable("wordfreq-3.1.1");
  await connectDB();

  console.log("Frequency (wordfreq Zipf)");
  console.log("─────────────────────────");

  for (const lang of ["en", "de"] as const) {
    const stats = await importLang(lang);
    console.log(
      `    ${stats.scored.toLocaleString()}/${stats.considered.toLocaleString()} scored` +
        (stats.viaForm ? ` · ${stats.viaForm.toLocaleString()} scored better via an inflected form` : "") +
        ` · ${stats.unseen.toLocaleString()} unseen by wordfreq`,
    );
  }

  await Provenance.deleteMany({ dataset: "wordfreq-3.1.1" });
  await Provenance.insertMany(provenanceDocs().filter((d) => d.dataset === "wordfreq-3.1.1"));
  console.log('  licence: CC BY-SA 4.0 · credit "Robyn Speer" (required by its NOTICE.md)');
  console.log("\nNext: npm run import:german-rank, then npm run recompute:difficulty");
}

runIfEntry(import.meta.url, main);
