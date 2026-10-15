/**
 * Import German→English glosses from Frank Richter's *ding* / Beolingus dictionary.
 *
 *   npm run import:ding
 *
 * Licence: **GPL-3+**, copyleft. That is why the text lands in its own `Gloss` documents rather
 * than being merged into the shared vocabulary — the glossary stays separable, attributable, and
 * removable as a unit (see models/Gloss.ts and MULTILINGUAL-REVIEW.md §5.2).
 *
 * The source is a *phrase* dictionary: one line lists the headword and then a run of example
 * phrases, with the English side mirroring them slot for slot. Reading later slots as further
 * meanings is how "Haus" collects "to stay home". `src/scripts/import/ding.ts` handles that, and
 * is tested against the real file.
 *
 * A headword often appears on several lines for different senses or domains. Lines are ranked —
 * exact spelling, then richness, then absence of a domain tag — and the best line supplies the
 * gloss; the runner-up contributes one alternative, so a review view can show that sources and
 * senses disagree.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { ensureGlossIndexes, Gloss } from "../../models/Gloss";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable, dataset } from "../../lib/licence/datasets";
import {
  groupByLemma,
  parseDing,
  rankEntries,
  type DingEntry,
} from "./ding";
import { runIfEntry } from "../run";

const SOURCE = "ding-beolingus-de-en";
const FILE = path.join(process.cwd(), "data", "de", "ding-de-en.txt");

/**
 * Ranking is a *cross-source* preference order: lower wins, whoever supplied it.
 *
 * Imported glosses therefore start at 1, leaving 0 for curated content. The demo's hand-written
 * glosses — including the false-friend note on "Gift" — outrank a dictionary dump, and if a better
 * source arrives later it can claim rank 0 without touching anything else.
 */
const FIRST_RANK = 1;
/** The runner-up gloss sits well behind the best one, so ordering alone picks the winner. */
const ALTERNATIVE_RANK = 10;

async function main() {
  const spec = assertShippable(SOURCE);
  if (!existsSync(FILE)) {
    throw new Error(`missing ${FILE}\nRun: src/scripts/import/fetch-data.sh`);
  }

  console.log("ding → German glosses (English)");
  console.log("───────────────────────────────");
  console.log(`  licence       ${spec.license} (copyleft: kept in its own collection)`);

  const { entries, skipped } = parseDing(readFileSync(FILE, "utf8"));
  const grouped = groupByLemma(entries);
  console.log(`  entries       ${entries.length.toLocaleString()} (${skipped} lines skipped)`);
  console.log(`  headwords     ${grouped.size.toLocaleString()}`);
  console.log(`  with article  ${entries.filter((e) => e.article).length.toLocaleString()}`);
  console.log(`  with plural   ${entries.filter((e) => e.plural).length.toLocaleString()}`);

  await connectDB();

  const dropped = await ensureGlossIndexes();
  for (const name of dropped) console.log(`  index         dropped stale unique index ${name}`);

  // Re-importing must not leave stale rows behind, so clear this source first.
  const removed = await Gloss.deleteMany({ source: SOURCE });
  if (removed.deletedCount) console.log(`  cleared       ${removed.deletedCount.toLocaleString()} previous rows`);

  const cursor = Word.find({ targetLang: "de" })
    .select("lemma lemmaKey pos article plural")
    .lean()
    .cursor();

  let considered = 0;
  let matched = 0;
  let glossesWritten = 0;
  let alternatives = 0;
  let morphologyFilled = 0;

  let glossOps: Array<Parameters<typeof Gloss.bulkWrite>[0][number]> = [];
  let wordOps: Array<Parameters<typeof Word.bulkWrite>[0][number]> = [];

  const flush = async (force = false) => {
    if (glossOps.length >= 2000 || (force && glossOps.length)) {
      const res = await Gloss.bulkWrite(glossOps, { ordered: false });
      glossesWritten += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
      glossOps = [];
    }
    if (wordOps.length >= 2000 || (force && wordOps.length)) {
      await Word.bulkWrite(wordOps, { ordered: false });
      wordOps = [];
    }
  };

  for await (const doc of cursor) {
    considered += 1;
    const candidates = grouped.get(doc.lemmaKey);
    if (!candidates?.length) continue;

    const ranked = rankEntries(candidates, doc.lemma);
    const best: DingEntry = ranked[0];
    matched += 1;

    const push = (text: string, rank: number) => {
      glossOps.push({
        updateOne: {
          filter: {
            targetLang: "de",
            lemmaKey: doc.lemmaKey,
            pos: doc.pos ?? "",
            lang: "en",
            source: SOURCE,
            text,
          },
          update: {
            $set: {
              wordId: doc._id,
              license: spec.license,
              generated: false,
              rank,
            },
          },
          upsert: true,
        },
      });
    };

    best.glosses.forEach((text, index) => push(text, FIRST_RANK + index));

    const runnerUp = ranked[1];
    if (runnerUp && runnerUp !== best) {
      const alternative = runnerUp.glosses[0];
      if (alternative && !best.glosses.includes(alternative)) {
        push(alternative, ALTERNATIVE_RANK);
        alternatives += 1;
      }
    }

    // Ding is a second source for gender and plural. Only fill gaps: kaikki already supplied
    // morphology for 66k entries and should not be overwritten by a different source's view.
    const fill: Record<string, string> = {};
    if (!doc.article && best.article) fill.article = best.article;
    if (!doc.plural && best.plural) fill.plural = best.plural;
    if (Object.keys(fill).length) {
      morphologyFilled += 1;
      wordOps.push({ updateOne: { filter: { _id: doc._id }, update: { $set: fill } } });
    }

    if (considered % 5000 === 0) {
      process.stdout.write(
        `\r  ${considered.toLocaleString()}/${278_699} considered · ${matched.toLocaleString()} matched`,
      );
    }
    await flush();
  }
  await flush(true);
  process.stdout.write("\n");

  console.log(`  matched       ${matched.toLocaleString()} of ${considered.toLocaleString()} German words`);
  console.log(`  gloss rows    ${glossesWritten.toLocaleString()} (incl. ${alternatives.toLocaleString()} alternatives)`);
  console.log(`  morphology    article/plural filled for ${morphologyFilled.toLocaleString()} words`);

  await Provenance.deleteMany({ dataset: SOURCE });
  await Provenance.insertMany(provenanceDocs().filter((d) => d.dataset === SOURCE));

  const total = await Gloss.countDocuments({ targetLang: "de", lang: "en" });
  console.log(`  total de→en   ${total.toLocaleString()} gloss rows in their own collection`);
  console.log(`\n  attribution   ${dataset(SOURCE).attribution}`);
}

runIfEntry(import.meta.url, main);
