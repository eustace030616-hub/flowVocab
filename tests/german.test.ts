/**
 * German importer tests — pure functions only, no database.
 *
 * The assertions about DWDS counts come from the real file in data/de/ and are skipped when it
 * has not been fetched. They are worth having: they pin the four `wortklasse` totals that the
 * licence review and the difficulty argument both rest on.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  buildGermanRows,
  difficultyForRow,
  parseDwdsCsv,
  parsePh98,
} from "../src/scripts/import/import-german";
import { assertShippable, shippableDatasets, DATASETS } from "../src/lib/licence/datasets";

const DWDS_PATH = path.join(process.cwd(), "data", "de", "dwds-lemmata.csv");
const PH98_PATH = path.join(process.cwd(), "data", "de", "ph98-german-cefr-wordlist.json");
const haveDwds = existsSync(DWDS_PATH);
const skipDwds = haveDwds ? false : "data/de not fetched — run `npm run fetch:data`";

/** Parsing a 27 MB CSV is slow; do it once for the whole file. */
let dwdsCache: ReturnType<typeof parseDwdsCsv> | null = null;
function dwds() {
  dwdsCache ??= parseDwdsCsv(readFileSync(DWDS_PATH, "utf8"));
  return dwdsCache;
}

test("DWDS parses to 281,195 letter-bearing lemmas with the published wortklasse totals", { skip: skipDwds }, () => {
  const rows = dwds();

  // The file has 281,207 rows. Twelve are pure symbols ("%", "‰", "∀", "∅") — real DWDS lemmas,
  // but not learnable vocabulary, so they are excluded.
  assert.equal(rows.length, 281_195);
  assert.equal(281_207 - rows.length, 12, "exactly 12 symbol-only entries are filtered");

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.pos, (counts.get(row.pos) ?? 0) + 1);

  // Published totals from DWDS are noun 203,995 / verb 21,240 / mwe 12,910; the small
  // differences here are exactly the filtered symbol entries.
  assert.equal(counts.get("noun"), 203_986);
  assert.equal(counts.get("verb"), 21_240);
  assert.equal(counts.get("mwe"), 12_909);
  // Adjektiv 29,380 + partizipiales Adjektiv 1,548 = 30,928, minus one symbol entry.
  assert.equal(counts.get("adjective"), 30_927);
});

test("DWDS frequency classes span 0–6 and leave ~45k lemmas unclassed", { skip: skipDwds }, () => {
  const rows = dwds();
  const classed = rows.filter((r) => r.frequencyClass !== undefined);

  assert.ok(classed.every((r) => r.frequencyClass! >= 0 && r.frequencyClass! <= 6));
  // 281,207 - 44,953 unclassed = 236,254, minus the filtered symbols.
  assert.equal(classed.length, 236_242);
  assert.equal(rows.filter((r) => r.frequencyClass === undefined).length, 281_195 - 236_242);
});

test("the frequent band is coarse: class 0 alone holds over 100k lemmas", { skip: skipDwds }, () => {
  // This is why German i+1 selection is only band-accurate today, so it is asserted rather
  // than merely written down in a comment.
  const class0 = dwds().filter((r) => r.frequencyClass === 0).length;
  assert.equal(class0, 112_490);
  assert.ok(class0 / 236_242 > 0.47, "almost half of all classed lemmas sit in one bucket");
});

test("difficulty comes from frequency when available, else the estimated level", () => {
  assert.equal(difficultyForRow({ dwdsFrequencyClass: 0, level: "C2" }), 0);
  assert.equal(difficultyForRow({ dwdsFrequencyClass: 6, level: "A1" }), 1);
  assert.ok(Math.abs(difficultyForRow({ level: "A1" }) - 0.5 / 6) < 1e-9);
  assert.equal(difficultyForRow({ level: null }), -1);
});

test("ph98 levels are always marked estimated — they are an LLM prior, not a wordlist", () => {
  const json = JSON.stringify([
    { word: "ich", rate: 5890279, level: "A1", rank: 1 },
    { word: "Wortschatz", rate: 1200, level: "B2", rank: 900 },
    { word: "kaputt", rate: 10, level: "not-a-level", rank: 2 },
  ]);
  const levels = parsePh98(json);

  assert.equal(levels.get("ich"), "A1");
  assert.equal(levels.get("wortschatz"), "B2");
  assert.equal(levels.size, 2, "an invalid level must be dropped, not coerced");
});

test("German rows never carry an unestimated level", () => {
  const dwds = [
    { lemma: "Haus", lemmaKey: "haus", pos: "noun", frequencyClass: 1 },
    { lemma: "Wortschatz", lemmaKey: "wortschatz", pos: "noun", frequencyClass: 4 },
  ];
  const rows = buildGermanRows(dwds, new Map([["wortschatz", "B2"]]));

  for (const row of rows) {
    if (row.level !== null) assert.equal(row.levelEstimated, true);
  }
  const haus = rows.find((r) => r.lemmaKey === "haus")!;
  assert.equal(haus.level, null, "no level evidence means null, never a guess");
  assert.equal(haus.levelEstimated, false);
});

test("no official German C1/C2 wordlist exists, so none may be imported", () => {
  // Goethe/DTZ/telc lists are the only authoritative German anchors and they are
  // offline-calibration-only. The catalogue must say so, and assertShippable must refuse them.
  const goethe = DATASETS["goethe-wortlisten-a1-a2-b1"];
  assert.ok(goethe, "the Goethe anchors must be catalogued");
  assert.equal(goethe.offlineOnly, true);
  assert.equal(goethe.commercialUse, false);
  assert.throws(() => assertShippable("goethe-wortlisten-a1-a2-b1"), /offline-calibration-only/);

  assert.throws(() => assertShippable("derewo"), /offline-calibration-only/);
  assert.throws(() => assertShippable("minimax-mt-glosses"), /offline-calibration-only/);

  // And the shippable set must contain no offline-only dataset.
  assert.ok(shippableDatasets().every((d) => !d.offlineOnly));
});

test("share-alike obligations are recorded, including the ones hidden by an MIT label", () => {
  const ph98 = DATASETS["ph98-german-cefr-wordlist"];
  assert.equal(ph98.shareAlike, true, "its rate column derives from CC BY-SA data");

  const wordfreq = DATASETS["wordfreq-3.1.1"];
  assert.equal(wordfreq.shareAlike, true);
  assert.equal(wordfreq.attribution, "Robyn Speer", "required verbatim by its NOTICE.md");

  const ding = DATASETS["ding-beolingus-de-en"];
  assert.equal(ding.copyleft, true);
  assert.equal(ding.commercialUse, true, "GPL permits commercial use, it just imposes copyleft");
});
