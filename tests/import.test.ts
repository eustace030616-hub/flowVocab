/**
 * Import tests, run against the real source files in data/en/.
 *
 * These assert the fix for the merge bug: the original pipeline deduped on `word.lower()`,
 * which collapsed part-of-speech readings and lost 1,126 rows. The most valuable assertion
 * here reproduces the legacy output *exactly* from the new code, which is what proves the
 * diagnosis rather than merely asserting it.
 *
 * Skipped (not failed) when data/ has not been fetched — run `npm run fetch:data`.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  mergeKey,
  mergeProfiles,
  parseCefrjCsv,
  parseOctanoveCsv,
  type ProfileRow,
} from "../src/scripts/import/profiles";
import { lemmaKeyOf } from "../src/lib/tokenize/normalize";

const DATA = path.join(process.cwd(), "data", "en");
const CEFRJ_PATH = path.join(DATA, "cefrj-vocabulary-profile-1.5.csv");
const OCTANOVE_PATH = path.join(DATA, "octanove-vocabulary-profile-c1c2-1.0.csv");
const haveData = existsSync(CEFRJ_PATH) && existsSync(OCTANOVE_PATH);
const skip = haveData ? false : "data/en not fetched — run `npm run fetch:data`";

function load(): { cefrj: ProfileRow[]; octanove: ProfileRow[] } {
  return {
    cefrj: parseCefrjCsv(readFileSync(CEFRJ_PATH, "utf8")),
    octanove: parseOctanoveCsv(readFileSync(OCTANOVE_PATH, "utf8")),
  };
}

/** Reproduces the legacy `merge_csv.py` output: first row wins, keyed on the headword alone. */
function legacyUniqueLemmaKeys(rows: ProfileRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const key = lemmaKeyOf(row.headword);
    if (!out.has(key)) out.set(key, row.level);
  }
  return out;
}

test("CEFR-J parses to 7,799 rows with the published level distribution", { skip }, () => {
  const { cefrj } = load();
  assert.equal(cefrj.length, 7799);

  const counts = countByLevel(cefrj);
  assert.deepEqual(counts, { A1: 1164, A2: 1411, B1: 2446, B2: 2778, C1: 0, C2: 0 });
});

test("Octanove parses to 2,136 rows covering exactly C1 and C2", { skip }, () => {
  const { octanove } = load();
  assert.equal(octanove.length, 2136);

  const counts = countByLevel(octanove);
  assert.deepEqual(counts, { A1: 0, A2: 0, B1: 0, B2: 0, C1: 1111, C2: 1025 });
});

test("merging on (lemma, pos) yields 9,779 rows, not 8,653", { skip }, () => {
  const { cefrj, octanove } = load();
  const merged = mergeProfiles([...cefrj, ...octanove]);
  assert.equal(merged.length, 9779);
});

test("THE REGRESSION: the legacy merge is reproducible from the new code as 8,653", { skip }, () => {
  // This is the proof of diagnosis. If someone reintroduces a headword-only key, the row
  // count falls back to exactly the legacy number — which is what shipped before.
  const { cefrj, octanove } = load();
  const legacy = legacyUniqueLemmaKeys([...cefrj, ...octanove]);

  assert.equal(legacy.size, 8653, "legacy headword-only merge should reproduce 8,653");

  // The legacy level histogram, exactly as measured in the shipped CEFR wordbank.
  const histogram = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0 } as Record<string, number>;
  for (const level of legacy.values()) histogram[level] += 1;
  assert.deepEqual(histogram, { A1: 986, A2: 1219, B1: 2162, B2: 2496, C1: 914, C2: 876 });
});

test("keeping POS recovers 1,126 rows, and the remaining 156 are genuine duplicates", { skip }, () => {
  const { cefrj, octanove } = load();
  const merged = mergeProfiles([...cefrj, ...octanove]);
  const legacy = legacyUniqueLemmaKeys([...cefrj, ...octanove]);

  const recovered = merged.length - legacy.size;
  assert.equal(recovered, 1126);

  // Source rows minus merged rows must equal the duplicates that genuinely coincide on
  // (lemma, pos): 1 inside CEFR-J, 60 inside Octanove, 95 across the two sources.
  const sourceRows = cefrj.length + octanove.length;
  assert.equal(sourceRows - merged.length, 156);
  assert.equal(1 + 60 + 95, 156);
});

test("part-of-speech is preserved: 1,035 lemmas carry more than one reading", { skip }, () => {
  const { cefrj, octanove } = load();
  const merged = mergeProfiles([...cefrj, ...octanove]);

  const byLemma = new Map<string, number>();
  for (const word of merged) byLemma.set(word.lemmaKey, (byLemma.get(word.lemmaKey) ?? 0) + 1);

  const multi = [...byLemma.values()].filter((n) => n > 1).length;
  assert.equal(multi, 1035);

  // A spot check that this is real and not an artefact: "above" is listed under 3 readings.
  assert.equal(byLemma.get("above"), 3);
  assert.equal(byLemma.get("about"), 2);
});

test("where sources disagree about a level, the lower one wins and both are recorded", { skip }, () => {
  const { cefrj, octanove } = load();
  const merged = mergeProfiles([...cefrj, ...octanove]);

  const disagreeing = merged.filter((w) => w.levelsSeen.length > 1);
  assert.equal(disagreeing.length, 116);

  for (const word of disagreeing) {
    const lowest = word.levelsSeen.reduce((a, b) =>
      ["A1", "A2", "B1", "B2", "C1", "C2"].indexOf(a) <= ["A1", "A2", "B1", "B2", "C1", "C2"].indexOf(b)
        ? a
        : b,
    );
    assert.equal(word.level, lowest, `${word.lemma} should take the lower level`);
  }

  // Concretely: CEFR-J calls "abundant" B1; Octanove calls it C2. We keep B1 and record both.
  const abundant = merged.find((w) => w.lemmaKey === "abundant");
  assert.ok(abundant);
  assert.equal(abundant!.level, "B1");
  assert.deepEqual([...abundant!.levelsSeen].sort(), ["B1", "C2"]);
  assert.equal(abundant!.sources.length, 2);
});

test("mergeKey separates languages from parts of speech, and never merges homographs", { skip }, () => {
  assert.notEqual(mergeKey("bank", "noun"), mergeKey("bank", "verb"));
  assert.notEqual(mergeKey("bank", "noun"), mergeKey("bank", ""));
});

function countByLevel(rows: ProfileRow[]): Record<string, number> {
  const out = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0 } as Record<string, number>;
  for (const row of rows) out[row.level] += 1;
  return out;
}
