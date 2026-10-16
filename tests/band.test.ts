/**
 * Passage banding by unknown-word count.
 *
 * The bands are the reader's own words: five new words is a different evening from twenty. What
 * matters in these tests is the boundary behaviour and the rule that a mark counts regardless of
 * what the model believes.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { BAND_EDGES, UNKNOWN_THRESHOLD, passageBand, unknownWords } from "../src/lib/learner/band";
import type { Span } from "../src/lib/tokenize";

const word = (surface: string, lemmaKey: string, start = 0): Span =>
  ({ kind: "word", surface, lemmaKey, start, end: start + surface.length, matched: true }) as Span;

test("the bands are <5 easy, 5-10 hard, above 10 very hard", () => {
  assert.equal(passageBand(0), "easy");
  assert.equal(passageBand(BAND_EDGES.easyMax), "easy", "4 unknown words is still easy");
  assert.equal(passageBand(BAND_EDGES.easyMax + 1), "hard", "5 is the first hard count");
  assert.equal(passageBand(BAND_EDGES.hardMax), "hard", "10 is the last hard count");
  assert.equal(passageBand(BAND_EDGES.hardMax + 1), "very_hard", "11 tips over");
  assert.equal(passageBand(40), "very_hard");
});

test("a word is unknown when the model puts it below the threshold", () => {
  const spans = [word("Haus", "haus"), word("Dach", "dach"), word("Zug", "zug")];
  const probabilities = new Map([
    ["haus", 0.99],
    ["dach", 0.79], // just below
    ["zug", UNKNOWN_THRESHOLD], // exactly at the threshold is known
  ]);
  const result = unknownWords(spans, { pKnownOf: (key) => probabilities.get(key) });
  assert.equal(result.count, 1);
  assert.deepEqual(result.lemmas, ["dach"]);
  assert.equal(result.markedCount, 0);
});

test("a marked word counts however confident the model is", () => {
  // The reader's own statement outranks the inference; that is what marking is for.
  const spans = [word("Haus", "haus"), word("Dach", "dach")];
  const result = unknownWords(spans, {
    pKnownOf: () => 0.999,
    isMarked: (key) => key === "dach",
  });
  assert.equal(result.count, 1);
  assert.deepEqual(result.lemmas, ["dach"]);
  assert.equal(result.markedCount, 1, "and it is attributed to the reader, not the model");
});

test("a repeated word is one unknown word, not one per occurrence", () => {
  // The band is vocabulary load. Coverage already accounts for repetition by summing over tokens.
  const spans = [word("Dach", "dach"), word("Dach", "dach", 20), word("Dach", "dach", 40)];
  const result = unknownWords(spans, { pKnownOf: () => 0.1 });
  assert.equal(result.count, 1);
});

test("an unread passage is still gradeable, because prediction fills the gap", () => {
  // Marks alone are retrospective: before reading, every passage would score 0 and read as easy.
  const spans = Array.from({ length: 12 }, (_, i) => word(`w${i}`, `w${i}`, i * 10));
  const result = unknownWords(spans, { pKnownOf: (key) => (key === "w0" ? 0.9 : 0.3) });
  assert.equal(result.count, 11);
  assert.equal(passageBand(result.count), "very_hard");
});

test("nothing marked and nothing predicted reads as easy", () => {
  const spans = [word("Haus", "haus"), word("Dach", "dach")];
  const result = unknownWords(spans, { pKnownOf: () => 0.99 });
  assert.equal(result.count, 0);
  assert.equal(passageBand(result.count), "easy");
});
