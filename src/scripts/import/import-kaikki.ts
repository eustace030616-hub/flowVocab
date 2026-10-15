/**
 * Two things from kaikki.org's German Wiktextract extract: how words inflect, and what they mean.
 *
 *   npm run import:kaikki
 *
 * ## Glosses
 *
 * ding is the primary German source — human-curated for 28 years — but its headword inventory is
 * thin on verbs: it has no entry for "brauchen" at all, although the word appears in 104 of its
 * example lists. Wiktionary defines it plainly, so this layer supplies what ding lacks. It ranks
 * *behind* ding, so it only ever fills holes rather than changing existing answers.
 *
 * ## Inflections
 *
 * The same pass records stated form→citation-form mappings (`liest` → `lesen`). Suffix rules
 * cannot derive that — the stem changes — and the failure is visible: "liest" matched an unrelated
 * noun entry and the learner saw a noun's headword glossed with a description of a verb form.
 * 72% of the German entries state their base, so this is data rather than a guess.
 *
 * Licence: CC BY-SA 4.0 + GFDL. Share-alike, so both live in their own collections.
 */

import { createGunzip } from "node:zlib";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { ensureGlossIndexes, Gloss } from "../../models/Gloss";
import { Inflection } from "../../models/Inflection";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable, dataset } from "../../lib/licence/datasets";
import { parseKaikkiEntry } from "./kaikki";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { runIfEntry } from "../run";

const SOURCE = "kaikki-wiktextract-de";
const FILE = path.join(process.cwd(), "data", "de", "kaikki-de.jsonl.gz");

/**
 * Behind ding (1–3) and behind curated content (0), so this source only fills gaps.
 */
const FIRST_RANK = 5;

async function main() {
  const spec = assertShippable(SOURCE);
  if (!existsSync(FILE)) {
    throw new Error(`missing ${path.relative(process.cwd(), FILE)}\nRun: src/scripts/import/fetch-data.sh --full`);
  }

  console.log("kaikki → German inflections and glosses");
  console.log("───────────────────────────────────────");
  console.log(`  licence      ${spec.license}`);

  await connectDB();
  const dropped = await ensureGlossIndexes();
  for (const name of dropped) console.log(`  index        dropped stale unique index ${name}`);

  const words = await Word.find({ targetLang: "de", origin: "import" })
    .select("lemmaKey pos")
    .lean();
  const wanted = new Map<string, Set<string>>();
  for (const word of words) {
    const set = wanted.get(word.lemmaKey);
    if (set) set.add(word.pos ?? "");
    else wanted.set(word.lemmaKey, new Set([word.pos ?? ""]));
  }
  console.log(`  vocabulary   ${wanted.size.toLocaleString()} German headwords`);

  const removedGlosses = await Gloss.deleteMany({ source: SOURCE });
  const removedForms = await Inflection.deleteMany({ source: SOURCE });
  if (removedGlosses.deletedCount || removedForms.deletedCount) {
    console.log(
      `  cleared      ${removedGlosses.deletedCount.toLocaleString()} gloss rows · ` +
        `${removedForms.deletedCount.toLocaleString()} inflection rows`,
    );
  }

  const rl = createInterface({
    input: createReadStream(FILE).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let lines = 0;
  let matched = 0;
  let written = 0;
  let formsStored = 0;
  let ops: Array<Parameters<typeof Gloss.bulkWrite>[0][number]> = [];
  let formOps: Array<Parameters<typeof Inflection.bulkWrite>[0][number]> = [];

  const flush = async () => {
    if (ops.length >= 2000) {
      await Gloss.bulkWrite(ops, { ordered: false });
      ops = [];
    }
    if (formOps.length >= 2000) {
      await Inflection.bulkWrite(formOps, { ordered: false });
      formOps = [];
    }
  };

  for await (const line of rl) {
    lines += 1;
    if (lines % 200_000 === 0) {
      process.stdout.write(`\r  reading… ${lines.toLocaleString()} lines · ${matched.toLocaleString()} matched`);
    }
    if (!line.includes('"lang": "German"') && !line.includes('"lang":"German"')) continue;

    const entry = parseKaikkiEntry(line);
    if (!entry) continue;

    // An inflected form: record the mapping, and only when the base is a word we hold.
    if (entry.formOf) {
      const baseLemmaKey = lemmaKeyOf(entry.formOf);
      if (!wanted.has(baseLemmaKey)) continue;
      matched += 1;
      formsStored += 1;
      formOps.push({
        updateOne: {
          filter: {
            targetLang: "de",
            form: entry.lemmaKey,
            baseLemmaKey,
            pos: entry.pos,
            source: SOURCE,
          },
          update: {
            $set: { base: entry.formOf, license: spec.license },
          },
          upsert: true,
        },
      });
      await flush();
      continue;
    }

    const positions = wanted.get(entry.lemmaKey);
    if (!positions) continue;
    matched += 1;

    // Attach to the entry's own part of speech when the vocabulary has it, else the unclassified
    // bucket — never invent a part of speech the vocabulary does not hold.
    const pos = positions.has(entry.pos) ? entry.pos : (positions.has("") ? "" : entry.pos);

    entry.glosses.forEach((text, index) => {
      written += 1;
      ops.push({
        updateOne: {
          filter: {
            targetLang: "de",
            lemmaKey: entry.lemmaKey,
            pos,
            lang: "en",
            source: SOURCE,
            text,
          },
          update: {
            $set: {
              license: spec.license,
              generated: false,
              rank: FIRST_RANK + index,
              termPos: entry.pos,
            },
          },
          upsert: true,
        },
      });
    });

    await flush();
  }
  if (ops.length) await Gloss.bulkWrite(ops, { ordered: false });
  if (formOps.length) await Inflection.bulkWrite(formOps, { ordered: false });
  process.stdout.write("\n");

  console.log(`  entries      ${lines.toLocaleString()} lines read · ${matched.toLocaleString()} matched a headword`);
  console.log(`  inflections  ${formsStored.toLocaleString()} form → citation-form mappings`);
  console.log(`  gloss rows   ${written.toLocaleString()}`);

  // What the layer was for: how many headwords now have a translation at all.
  const withGloss = await Gloss.distinct("lemmaKey", { targetLang: "de", lang: "en" });
  console.log(`  coverage     ${withGloss.length.toLocaleString()} German headwords now have an English gloss`);

  await Provenance.deleteMany({ dataset: SOURCE });
  await Provenance.insertMany(provenanceDocs().filter((d) => d.dataset === SOURCE));
  console.log(`\n  attribution  ${dataset(SOURCE).attribution}`);
}

runIfEntry(import.meta.url, main);
