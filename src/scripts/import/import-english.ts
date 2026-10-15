/**
 * Import the English CEFR profiles into Word documents.
 *
 *   npm run import:english
 *
 * Writes one Word per (targetLang="en", lemma, pos). Glosses are deliberately NOT attached
 * here: the only Chinese glosses that exist today came from persisted Minimax MT output, which
 * is marked offline-only in the licence catalogue until the vendor's terms are checked. They
 * will be replaced by CC-CEDICT-derived glosses in a later pass.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable, DATASETS } from "../../lib/licence/datasets";
import {
  CEFRJ_SOURCE,
  difficultyFromLevel,
  levelHistogram,
  mergeProfiles,
  OCTANOVE_SOURCE,
  parseCefrjCsv,
  parseOctanoveCsv,
} from "./profiles";
import { sha256File } from "../../lib/licence";
import { runIfEntry } from "../run";

const DATA = path.join(process.cwd(), "data", "en");
const CEFRJ_PATH = path.join(DATA, "cefrj-vocabulary-profile-1.5.csv");
const OCTANOVE_PATH = path.join(DATA, "octanove-vocabulary-profile-c1c2-1.0.csv");

function require_(file: string): string {
  if (!existsSync(file)) {
    throw new Error(`missing ${file}\nRun: npm run fetch:data`);
  }
  return readFileSync(file, "utf8");
}

async function main() {
  // Fail loudly if either dataset is ever mis-declared as offline-only.
  const cefrjSpec = assertShippable(CEFRJ_SOURCE);
  const octanoveSpec = assertShippable(OCTANOVE_SOURCE);

  const cefrjRows = parseCefrjCsv(require_(CEFRJ_PATH));
  const octanoveRows = parseOctanoveCsv(require_(OCTANOVE_PATH));
  const merged = mergeProfiles([...cefrjRows, ...octanoveRows]);

  const sourceRows = cefrjRows.length + octanoveRows.length;
  const legacyHeadwords = new Set(merged.map((m) => m.lemmaKey)).size;

  console.log("English CEFR import");
  console.log("──────────────────");
  console.log(`  CEFR-J rows                 ${cefrjRows.length}`);
  console.log(`  Octanove rows               ${octanoveRows.length}`);
  console.log(`  source rows                 ${sourceRows}`);
  console.log(`  merged on (lemma, pos)      ${merged.length}`);
  console.log(`  headword-only (legacy)      ${legacyHeadwords}`);
  console.log(`  recovered by keeping POS    ${merged.length - legacyHeadwords}`);
  console.log(`  levels                      ${JSON.stringify(levelHistogram(merged))}`);

  await connectDB();

  const licenceOf = (source: string) =>
    source === CEFRJ_SOURCE ? cefrjSpec.license : octanoveSpec.license;

  const ops = merged.map((word) => ({
    updateOne: {
      filter: { targetLang: "en" as const, lemmaKey: word.lemmaKey, pos: word.pos },
      update: {
        $set: {
          // Present in a dataset, so it is a dictionary entry and may inform tokenization.
          origin: "import" as const,
          lemma: word.lemma,
          difficulty: difficultyFromLevel(word.level),
          level: word.level,
          levelEstimated: word.levelEstimated,
          levelSource: word.levelSource,
        },
        $setOnInsert: {
          targetLang: "en" as const,
          lemmaKey: word.lemmaKey,
          pos: word.pos,
          surfaceForms: [],
          frequency: {},
        },
      },
      upsert: true,
    },
  }));

  let written = 0;
  const BATCH = 1000;
  for (let i = 0; i < ops.length; i += BATCH) {
    const res = await Word.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    written += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
    process.stdout.write(`\r  writing… ${Math.min(i + BATCH, ops.length)}/${ops.length}`);
  }
  process.stdout.write("\n");

  // Record provenance + licence text for the datasets we just used.
  await Provenance.deleteMany({ dataset: { $in: [CEFRJ_SOURCE, OCTANOVE_SOURCE] } });
  await Provenance.insertMany(
    provenanceDocs().filter((d) => d.dataset === CEFRJ_SOURCE || d.dataset === OCTANOVE_SOURCE),
  );

  const cefrjSha = await sha256File(CEFRJ_PATH);
  const octanoveSha = await sha256File(OCTANOVE_PATH);
  await Provenance.updateOne({ dataset: CEFRJ_SOURCE }, { $set: { sha256: cefrjSha, rowCount: cefrjRows.length } });
  await Provenance.updateOne(
    { dataset: OCTANOVE_SOURCE },
    { $set: { sha256: octanoveSha, rowCount: octanoveRows.length } },
  );

  console.log(`  words written/updated       ${written}`);
  console.log(`  licence                     ${licenceOf(CEFRJ_SOURCE)} / ${licenceOf(OCTANOVE_SOURCE)}`);
  console.log(`  offline-only datasets used  none (${Object.values(DATASETS).filter((d) => d.offlineOnly).length} exist and are excluded)`);
  console.log("\nGlosses: not imported. Existing Chinese glosses are persisted MT output and are");
  console.log("marked offline-only until the vendor terms are verified.");
}

runIfEntry(import.meta.url, main);
