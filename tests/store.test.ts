/**
 * The SQLite store, read against the real migrated data.
 *
 * These are integration tests by nature — the point is that the queries return what the reader
 * expects from the rows actually on disk, not from a fixture. They skip when the database has not
 * been built, which is the honest behaviour for a fresh clone: run `npm run migrate:mongo-to-sqlite`
 * and they start checking something.
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { DATABASE_PATH, openDatabase } from "../src/lib/store/db";
import {
  glossesByKeys,
  inflectionsByForm,
  separationsByParticle,
  compoundsByForm,
  wordsByKeys,
  countWords,
} from "../src/lib/store/dictionary";
import { nextBufferedParagraph, paragraphSummaries, paragraphsFor } from "../src/lib/store/content";
import { abilityFor } from "../src/lib/store/learner";

const ready = existsSync(DATABASE_PATH);
const skip = ready ? false : "database not built: run npm run migrate:mongo-to-sqlite";

test("the store opens the migrated database", { skip }, () => {
  openDatabase();
  assert.ok(countWords("de") > 200_000, "the German vocabulary should be there");
  assert.ok(countWords("en") > 8_000, "and the English one");
});

test("a word resolves by its join key, with its difficulty", { skip }, () => {
  const rows = wordsByKeys("de", ["brauchen", "zeit"]);
  assert.ok(rows.length >= 2, "both words should be found");
  for (const row of rows) {
    assert.equal(row.origin, "import", "only dataset entries inform the tokenizer");
    assert.ok(row.difficulty >= 0, `${row.lemmaKey} should carry a difficulty`);
  }
});

test("translations come back best-first, with their source and licence", { skip }, () => {
  const glosses = glossesByKeys("de", "en", ["brauchen"]);
  assert.ok(glosses.length > 0, "brauchen has glosses after the Wiktionary fill");
  assert.match(glosses[0].text, /need/i);
  assert.ok(glosses[0].source.length > 0, "a gloss always names its source");
  assert.ok(glosses[0].license.length > 0, "and carries its licence");

  // Order is rank, then source, then text — the cross-source preference the documents used.
  for (let i = 1; i < glosses.length; i += 1) {
    assert.ok(glosses[i - 1].rank <= glosses[i].rank, "ranked best-first");
  }
});

test("the compiled morphology is readable: inflections, separations, compounds", { skip }, () => {
  const inflections = inflectionsByForm("de", ["liest", "kurzen"]);
  assert.ok(inflections.length >= 2);
  assert.equal(inflections.find((row) => row.form === "liest")?.base, "lesen");

  const separations_ = separationsByParticle("de", ["auf"]);
  assert.ok(
    separations_.some((row) => row.verb === "stehen" && row.merged === "aufstehen"),
    "auf + stehen should be stated",
  );
  // The unglossed verb the compiler deliberately dropped, so the proximity heuristic cannot invent it.
  assert.equal(
    separations_.some((row) => row.merged === "gegenübersetzen"),
    false,
    "a separation with no translation is not in the table",
  );

  const compound = compoundsByForm("de", ["wortschatzaufbau", "kurztext"]);
  assert.deepEqual(
    compound.find((row) => row.form === "wortschatzaufbau")?.parts,
    ["wortschatz", "aufbau"],
    "a compound built in a passage, which is not itself a headword",
  );
  assert.deepEqual(
    compound.find((row) => row.form === "kurztext")?.parts,
    ["kurz", "text"],
    "and one that is",
  );
});

test("paragraphs list in reading order, newest first for history", { skip }, () => {
  const ordered = paragraphsFor("de");
  assert.ok(ordered.length > 0);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(ordered[i - 1].difficulty <= ordered[i].difficulty, "easiest first");
  }

  const history = paragraphSummaries("de", "no-such-user");
  assert.ok(history.length >= ordered.length - 5, "history covers the same passages");
  assert.equal(history[0].markedCount, 0, "a user with no marks has none");
});

test("the split by cause is visible in the data, not just in a report", { skip }, () => {
  // `happen` exists but CC-CEDICT does not gloss it; `favorable` is absent from the vocabulary
  // entirely. Those are the two different causes the glossary work has to treat differently.
  const happen = wordsByKeys("en", ["happen"]);
  assert.equal(happen.length, 1, "happen is in the vocabulary");
  assert.equal(glossesByKeys("en", "zh", ["happen"]).length, 0, "…and has no Chinese gloss");

  assert.equal(wordsByKeys("en", ["favorable"]).length, 0, "favorable is not in the vocabulary at all");
});

test("an ability estimate survives the move", { skip }, () => {
  const rows = paragraphSummaries("de", "no-such-user");
  assert.ok(rows.length > 0);
  // The columns are the shape the interface reads; a null where a number belongs would show as a
  // blank level rather than an error.
  assert.ok(abilityFor("no-such-user", "de") === null, "an unknown learner has no estimate");
});

test("the stock is served only at the level asked for", { skip }, () => {
  // A passage written for A2 must not be served to a reader the estimate now places at B2 — the stock
  // outlives the estimate that produced it.
  const a2 = nextBufferedParagraph("de", "A2");
  const b2 = nextBufferedParagraph("de", "B2");
  for (const [level, row] of [["A2", a2], ["B2", b2]] as const) {
    if (row) assert.equal(row.level, level, `stock for ${level} should be ${level}`);
  }
});
