/**
 * Import English→Chinese glosses from CC-CEDICT.
 *
 *   npm run import:cedict
 *
 * Licence: **CC BY-SA 4.0**. Share-alike, so the gloss text lands in its own `Gloss` documents
 * alongside ding, never merged into the shared vocabulary (see models/Gloss.ts).
 *
 * CC-CEDICT is Chinese→English; this inverts it by indexing the English glosses. The inversion is
 * only as good as the ranking, and ranking on specificity is actively wrong — 犬 translates exactly
 * one English word and 狗 translates several, but 狗 is the word a learner needs. So candidates are
 * ordered by wordfreq Zipf for Chinese, which needs `jieba` (see requirements-wordfreq.txt). The
 * Zipf table is generated once and cached; a machine without the Python environment can still
 * import as long as that file exists.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { ensureGlossIndexes, Gloss } from "../../models/Gloss";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable, dataset } from "../../lib/licence/datasets";
import {
  estimateTermPos,
  invertGlosses,
  parseCedict,
  rankChineseCandidates,
  type PartOfSpeech,
} from "./cedict";
import { runIfEntry } from "../run";

const SOURCE = "cc-cedict";
const DIR = path.join(process.cwd(), "data", "zh");
const TEXT = path.join(DIR, "cedict_ts.u8");
const ZIPF = path.join(DIR, "cedict-zipf.json");
const WORDS = path.join(DIR, "cedict-words.txt");
const PYTHON = path.join(process.cwd(), ".venv-data", "bin", "python");
const EXPORTER = path.join(process.cwd(), "src", "scripts", "import", "wordfreq_export.py");

/** Imported glosses rank behind curated ones, exactly as in the ding import. */
const FIRST_RANK = 1;
const MAX_CANDIDATES = 3;

/**
 * Load Chinese frequencies, generating them if they are missing.
 *
 * wordfreq is a Python package with no Node equivalent, so this shells out to the same exporter
 * used for the other languages. The result is cached in data/, which means the step only has to
 * succeed once on a machine that has the environment — `data/` is shared with the container.
 */
function ensureZipf(candidates: string[]): Map<string, number> {
  if (!existsSync(ZIPF)) {
    if (!existsSync(PYTHON)) {
      throw new Error(
        `missing ${path.relative(process.cwd(), ZIPF)} and no Python environment at .venv-data.\n` +
          `Run: python3 -m venv .venv-data && ./.venv-data/bin/pip install -r src/scripts/import/requirements-wordfreq.txt\n` +
          `Then: ./.venv-data/bin/python ${path.relative(process.cwd(), EXPORTER)} zh data/zh/cedict-words.txt data/zh/cedict-zipf.json`,
      );
    }
    writeFileSync(WORDS, `${candidates.join("\n")}\n`, "utf8");
    console.log(`  scoring ${candidates.length.toLocaleString()} Chinese forms with wordfreq…`);
    const result = spawnSync(PYTHON, [EXPORTER, "zh", WORDS, ZIPF], { stdio: "inherit" });
    if (result.status !== 0 || !existsSync(ZIPF)) {
      throw new Error(
        "the wordfreq export failed. Chinese tokenisation needs jieba: " +
          "./.venv-data/bin/pip install -r src/scripts/import/requirements-wordfreq.txt",
      );
    }
  }

  const parsed = JSON.parse(readFileSync(ZIPF, "utf8")) as { zipf: Record<string, number> };
  return new Map(Object.entries(parsed.zipf));
}

async function main() {
  const spec = assertShippable(SOURCE);
  if (!existsSync(TEXT)) {
    throw new Error(
      `missing ${path.relative(process.cwd(), TEXT)}\n` +
        `Run: npm run fetch:data   (then unzip data/zh/cedict_1_0_ts_utf-8_mdbg.zip)`,
    );
  }

  console.log("CC-CEDICT → English glosses (Chinese)");
  console.log("────────────────────────────────────");
  console.log(`  licence      ${spec.license} (share-alike: kept in its own collection)`);

  const { entries, skipped } = parseCedict(readFileSync(TEXT, "utf8"));
  const inverted = invertGlosses(entries);
  const { byGloss, genericness, byForm, verbMarked } = inverted;
  console.log(`  entries      ${entries.length.toLocaleString()} (${skipped} lines skipped)`);
  console.log(`  gloss keys   ${byGloss.size.toLocaleString()} distinct English words indexed`);

  await connectDB();

  const dropped = await ensureGlossIndexes();
  for (const name of dropped) console.log(`  index        dropped stale unique index ${name}`);

  // The English vocabulary carries the part of speech of every headword — the signal CC-CEDICT
  // itself lacks — and also tells us the part of speech of any gloss that is itself a headword.
  const englishWords = await Word.find({ targetLang: "en" }).select("lemmaKey pos").lean();
  const wanted = new Set(englishWords.map((w) => w.lemmaKey));
  const vocabPos = new Map<string, string[]>();
  for (const word of englishWords) {
    if (!word.pos) continue;
    const list = vocabPos.get(word.lemmaKey);
    if (list) {
      if (!list.includes(word.pos)) list.push(word.pos);
    } else {
      vocabPos.set(word.lemmaKey, [word.pos]);
    }
  }
  console.log(`  pos signals  ${vocabPos.size.toLocaleString()} English headwords carry a part of speech`);

  const termPosCache = new Map<string, PartOfSpeech | null>();
  const termPosOf = (form: string): PartOfSpeech | null => {
    if (!termPosCache.has(form)) {
      termPosCache.set(form, estimateTermPos(form, { inverted, vocabPos }).pos);
    }
    return termPosCache.get(form) ?? null;
  };
  void byForm;
  void verbMarked;

  const candidateForms = new Set<string>();
  for (const key of wanted) {
    for (const form of byGloss.get(key) ?? []) candidateForms.add(form);
  }
  console.log(`  candidates   ${candidateForms.size.toLocaleString()} Chinese forms for ${wanted.size.toLocaleString()} English words`);

  const zipf = ensureZipf([...candidateForms]);

  const removed = await Gloss.deleteMany({ source: SOURCE });
  if (removed.deletedCount) console.log(`  cleared      ${removed.deletedCount.toLocaleString()} previous rows`);

  let matched = 0;
  let written = 0;
  let unranked = 0;
  let ops: Array<Parameters<typeof Gloss.bulkWrite>[0][number]> = [];

  // One pass per vocabulary ENTRY, not per lemma: train/noun and train/verb are separate rows and
  // must get separate gloss sets.
  for (const doc of await Word.find({ targetLang: "en" })
    .select("lemmaKey pos")
    .lean()) {
    const candidates = byGloss.get(doc.lemmaKey);
    if (!candidates?.length) continue;
    matched += 1;

    const ranked = rankChineseCandidates(candidates, { zipf, genericness }, {
      preferPos: doc.pos || undefined,
      termPosOf,
    }).slice(0, MAX_CANDIDATES);
    if (ranked.every((form) => (zipf.get(form) ?? 0) === 0)) unranked += 1;

    ranked.forEach((text, index) => {
      written += 1;
      ops.push({
        updateOne: {
          filter: {
            targetLang: "en",
            lemmaKey: doc.lemmaKey,
            pos: doc.pos ?? "",
            lang: "zh",
            source: SOURCE,
            text,
          },
          update: {
            $set: {
              wordId: doc._id,
              license: spec.license,
              generated: false,
              rank: FIRST_RANK + index,
              weight: zipf.get(text) ?? 0,
              termPos: termPosOf(text),
            },
          },
          upsert: true,
        },
      });
    });

    if (ops.length >= 2000) {
      await Gloss.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }
  if (ops.length) await Gloss.bulkWrite(ops, { ordered: false });

  console.log(`  matched      ${matched.toLocaleString()} of ${wanted.size.toLocaleString()} English words`);
  console.log(`  gloss rows   ${written.toLocaleString()}`);
  if (unranked) {
    console.log(`  no frequency ${unranked.toLocaleString()} words had candidates but no Zipf score (ranked by length)`);
  }

  await Provenance.deleteMany({ dataset: SOURCE });
  await Provenance.insertMany(provenanceDocs().filter((d) => d.dataset === SOURCE));

  const total = await Gloss.countDocuments({ targetLang: "en", lang: "zh" });
  console.log(`  total en→zh  ${total.toLocaleString()} gloss rows`);
  console.log(`\n  attribution  ${dataset(SOURCE).attribution}`);
}

runIfEntry(import.meta.url, main);
