/**
 * Import the curated function-word glosses.
 *
 *   npm run import:function-words
 *
 * Small, curated and separate from the corpora, exactly like the seed glosses: these are the
 * translations no dictionary of either language will give you, because neither language's dictionary
 * treats `the` as a headword with a translation. Rank 0, so they outrank anything imported.
 */

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Gloss } from "../../models/Gloss";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable } from "../../lib/licence/datasets";
import { ENGLISH_FUNCTION_GLOSSES, GERMAN_FUNCTION_GLOSSES } from "./function-words";
import { runIfEntry } from "../run";

const SOURCE = "flowwing-function-words";

async function main() {
  const spec = assertShippable(SOURCE);
  console.log("function words → English glosses in Chinese");
  console.log("──────────────────────────────────────────");
  console.log(`  licence      ${spec.license}`);

  await connectDB();

  // Cleared once, before either language: the source name is shared, so clearing per language threw
  // away the rows the previous pass had just written.
  const cleared = await Gloss.deleteMany({ source: SOURCE });
  if (cleared.deletedCount) console.log(`  cleared      ${cleared.deletedCount} previous rows`);

  const plans = [
    { targetLang: "en" as const, lang: "zh" as const, glosses: ENGLISH_FUNCTION_GLOSSES },
    { targetLang: "de" as const, lang: "en" as const, glosses: GERMAN_FUNCTION_GLOSSES },
  ];

  for (const plan of plans) {
  const keys = Object.keys(plan.glosses);
  const words = await Word.find({ targetLang: plan.targetLang, lemmaKey: { $in: keys }, origin: "import" })
    .select("lemmaKey pos")
    .lean();
  const byKey = new Map(words.map((w) => [w.lemmaKey, w]));
  console.log(`  ${plan.targetLang} → ${plan.lang}: ${keys.length} curated`);

  let written = 0;
  const missing: string[] = [];
  const ops = [];
  for (const key of keys) {
    const word = byKey.get(key);
    // Only words the vocabulary actually holds: a gloss for something nobody can look up is noise.
    if (!word) {
      missing.push(key);
      continue;
    }
    written += 1;
    ops.push({
      updateOne: {
        filter: { targetLang: plan.targetLang, lemmaKey: key, pos: word.pos ?? "", lang: plan.lang, source: SOURCE, text: plan.glosses[key] },
        update: { $set: { license: spec.license, generated: false, rank: 0, termPos: null } },
        upsert: true,
      },
    });
  }
  if (ops.length) await Gloss.bulkWrite(ops, { ordered: false });

  console.log(`               matched ${written} vocabulary entries`);
  if (missing.length) console.log(`               not held: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
  }

  const glossed = await Gloss.distinct("lemmaKey", { targetLang: "en", lang: "zh" });
  const totalE = await Word.countDocuments({ targetLang: "en", origin: "import" });
  const glossedDe = await Gloss.distinct("lemmaKey", { targetLang: "de", lang: "en" });
  const totalD = await Word.countDocuments({ targetLang: "de", origin: "import" });
  console.log(`  coverage     en ${glossed.length}/${totalE} · de ${glossedDe.length}/${totalD}`);

  await Provenance.deleteMany({ dataset: SOURCE });
  await Provenance.insertMany(provenanceDocs().filter((d) => d.dataset === SOURCE));
}

runIfEntry(import.meta.url, main);
