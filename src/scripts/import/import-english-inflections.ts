/**
 * Import the curated irregular English forms into the `Inflection` collection.
 *
 *   npm run import:english-inflections
 *
 * The mechanisms already exist — the collection, the unique index, and the tokenizer's stated-form
 * lookup, all built for German. This supplies the English side of the data.
 */

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Inflection } from "../../models/Inflection";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable } from "../../lib/licence/datasets";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { ENGLISH_IRREGULAR_FORMS } from "./english-irregular-verbs";
import { runIfEntry } from "../run";

const SOURCE = "flowwing-english-inflections";

async function main() {
  const spec = assertShippable(SOURCE);
  console.log("irregular English forms → base forms");
  console.log("───────────────────────────────────");
  console.log(`  licence      ${spec.license}`);

  await connectDB();

  const bases = [...new Set(Object.values(ENGLISH_IRREGULAR_FORMS))];
  const baseWords = await Word.find({ targetLang: "en", lemmaKey: { $in: bases }, origin: "import" })
    .select("lemmaKey pos")
    .lean();
  // A mapping is only useful when its base can be looked up and glossed — the same rule the German
  // import follows, so a stated form can never resolve to something the reader cannot explain.
  const basePos = new Map(baseWords.map((w) => [w.lemmaKey, w.pos ?? ""]));

  const cleared = await Inflection.deleteMany({ source: SOURCE });
  if (cleared.deletedCount) console.log(`  cleared      ${cleared.deletedCount} previous rows`);

  const ops = [];
  const skipped: string[] = [];
  for (const [form, base] of Object.entries(ENGLISH_IRREGULAR_FORMS)) {
    const baseLemmaKey = lemmaKeyOf(base);
    if (!basePos.has(baseLemmaKey)) {
      skipped.push(`${form}→${base}`);
      continue;
    }
    ops.push({
      updateOne: {
        filter: { targetLang: "en", form: lemmaKeyOf(form), baseLemmaKey, pos: basePos.get(baseLemmaKey) ?? "", source: SOURCE },
        update: { $set: { base, license: spec.license } },
        upsert: true,
      },
    });
  }
  if (ops.length) await Inflection.bulkWrite(ops, { ordered: false });

  console.log(`  curated      ${Object.keys(ENGLISH_IRREGULAR_FORMS).length} forms`);
  console.log(`  imported     ${ops.length} mappings`);
  if (skipped.length) console.log(`  skipped      ${skipped.length} whose base is not in the vocabulary: ${skipped.slice(0, 8).join(", ")}`);

  const total = await Inflection.countDocuments({ targetLang: "en" });
  console.log(`  english      ${total} stated forms now available to the tokenizer`);

  await Provenance.deleteMany({ dataset: SOURCE });
  await Provenance.insertMany(provenanceDocs().filter((d) => d.dataset === SOURCE));
}

runIfEntry(import.meta.url, main);
