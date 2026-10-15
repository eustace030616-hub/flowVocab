/**
 * Attach Leipzig corpus ranks to the German vocabulary.
 *
 *   npm run import:german-rank
 *
 * Why this matters more than it sounds: DWDS's Häufigkeitsklasse puts **112,490 of 236,242**
 * classed lemmas in class 0 alone — 47% of the vocabulary in a single bucket. German difficulty
 * was therefore band-accurate at best, and could not choose a sensible *next* word for a
 * beginner. Leipzig gives a rank for every surface form, which splits that bucket.
 *
 * The corpus is wordform-based and rank is per-corpus, so this is deliberately kept as a
 * *second, independent* column rather than being averaged with DWDS. Agreement between the two is
 * a confidence signal; there is no calibration between them.
 *
 * Licence: CC BY 4.0 (Leipzig Corpora Collection).
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable } from "../../lib/licence/datasets";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { runIfEntry } from "../run";

const ARCHIVE = path.join(process.cwd(), "data", "de", "leipzig-deu_news_2024_1M.tar.gz");

/** Find the member holding the word/frequency list, whatever the corpus names it. */
async function findWordsMember(archive: string): Promise<string> {
  const listing = spawn("tar", ["-tzf", archive]);
  const rl = createInterface({ input: listing.stdout });
  let found: string | null = null;
  for await (const line of rl) {
    const name = line.trim();
    if (name.endsWith("-words.txt")) {
      found = name;
      break;
    }
  }
  listing.kill();
  if (!found) throw new Error(`no *-words.txt member inside ${path.basename(archive)}`);
  return found;
}

async function extractMember(archive: string, member: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "leipzig-"));
  const out = path.join(dir, "words.txt");
  const child = spawn("tar", ["-xzOf", archive, member]);
  await pipeline(child.stdout, createWriteStream(out));
  return out;
}

/** The corpus writes `rank<TAB>word<TAB>frequency`, with a BOM on some lines. */
const STRIP = /[\uFEFF\u200B-\u200D]/g;

/**
 * Read the corpus's own ranks, keyed by lowercased form.
 *
 * The file already supplies a rank per exact form, so there is nothing to recompute. Case
 * variants are separate rows ("über" and "Über"), and a learner meets both, so a lowercased key
 * keeps the *best* rank of the variants.
 *
 * The shape is validated on the first data line and the function throws if it does not match.
 * An earlier version assumed two columns and silently read the rank column as the word, which
 * produced 25,667 numeric "words" and ranked nothing at all — a failure that looked like success.
 */
async function buildRanks(
  wordsFile: string,
  onProgress?: (lines: number) => void,
): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  const rl = createInterface({ input: createReadStream(wordsFile), crlfDelay: Infinity });

  let lines = 0;
  let validated = false;

  for await (const line of rl) {
    lines += 1;
    if (lines % 200_000 === 0) onProgress?.(lines);

    const fields = line.split("\t");
    if (!validated) {
      const rank = Number.parseInt(fields[0], 10);
      if (fields.length < 3 || !Number.isFinite(rank)) {
        throw new Error(
          `unexpected ${path.basename(wordsFile)} format: expected "rank<TAB>word<TAB>frequency", ` +
            `got ${JSON.stringify(line.slice(0, 80))}`,
        );
      }
      validated = true;
    }
    if (fields.length < 2) continue;

    const rank = Number.parseInt(fields[0], 10);
    const word = fields[1].replace(STRIP, "").trim();
    if (!word || !Number.isFinite(rank)) continue;

    const key = lemmaKeyOf(word);
    const existing = ranks.get(key);
    if (existing === undefined || rank < existing) ranks.set(key, rank);
  }

  return ranks;
}

async function main() {
  assertShippable("leipzig-corpora");

  if (!existsSync(ARCHIVE)) {
    throw new Error(`missing ${ARCHIVE}\nRun: src/scripts/import/fetch-data.sh --full`);
  }
  const size = (await stat(ARCHIVE)).size;
  console.log("Leipzig rank (German)");
  console.log("─────────────────────");
  console.log(`  archive       ${(size / 1e6).toFixed(0)} MB`);

  const member = await findWordsMember(ARCHIVE);
  console.log(`  member        ${member}`);
  const wordsFile = await extractMember(ARCHIVE, member);

  const ranks = await buildRanks(wordsFile, (n) =>
    process.stdout.write(`\r  reading… ${n.toLocaleString()} lines`),
  );
  process.stdout.write("\n");
  console.log(`  distinct forms ${ranks.size.toLocaleString()}`);
  await rm(path.dirname(wordsFile), { recursive: true, force: true });

  await connectDB();

  // Rank a lemma by the best rank among the word itself and any surface form we know.
  const cursor = Word.find({ targetLang: "de" }).select("lemmaKey surfaceForms").lean().cursor();
  const ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
  let considered = 0;
  let ranked = 0;

  for await (const doc of cursor) {
    considered += 1;
    let best: number | undefined;
    for (const form of [doc.lemmaKey, ...(doc.surfaceForms ?? [])]) {
      const rank = ranks.get(lemmaKeyOf(form));
      if (rank !== undefined && (best === undefined || rank < best)) best = rank;
    }
    if (best === undefined) continue;
    ranked += 1;
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { "frequency.leipzig": best } },
      },
    });

    if (ops.length >= 2000) {
      await Word.bulkWrite(ops.splice(0, ops.length), { ordered: false });
      process.stdout.write(`\r  ranked… ${ranked.toLocaleString()}/${considered.toLocaleString()}`);
    }
  }
  if (ops.length) await Word.bulkWrite(ops, { ordered: false });
  process.stdout.write("\n");

  console.log(`  lemmas ranked  ${ranked.toLocaleString()} of ${considered.toLocaleString()}`);

  await Provenance.deleteMany({ dataset: "leipzig-corpora" });
  await Provenance.insertMany(provenanceDocs().filter((d) => d.dataset === "leipzig-corpora"));
  console.log("  licence: CC BY 4.0 — Leipzig Corpora Collection, Universität Leipzig");
  console.log("\nNext: npm run recompute:difficulty");
}

runIfEntry(import.meta.url, main);
