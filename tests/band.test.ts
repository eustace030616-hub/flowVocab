/**
 * Passage banding by unknown-word count.
 *
 * The bands are the reader's own words: five new words is a different evening from twenty. What
 * matters in these tests is the boundary behaviour and the rule that a mark counts regardless of
 * what the model believes.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  BAND_EDGES,
  UNKNOWN_THRESHOLD,
  passageBand,
  targetBriefLevel,
  unknownWords,
} from "../src/lib/learner/band";
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

test("the target writes one band above the estimate, so reading can raise it", () => {
  // The bootstrapping deadlock: an estimate cannot rise above the hardest word it has been shown, so
  // text chosen *at* the estimate can never test whether the estimate is too low. Measured on a real
  // learner reading five passages unmarked: 0.500 → 0.532 → 0.555 → 0.555, then it stopped.
  assert.equal(targetBriefLevel(0.25), "B1", "an A2 estimate is served B1 text");
  assert.equal(targetBriefLevel(0.42), "B2");
  assert.equal(targetBriefLevel(0.75), "B2", "clamped at the top of the brief range");
  assert.equal(targetBriefLevel(0.02), "A2", "and at the bottom — below A2 there is no scene to build");
  assert.equal(targetBriefLevel(0.9), "B2");
});

test("the route and the pregenerator cannot disagree about the target", () => {
  // They did: the route moved to θ+1 while the stock was still written at θ, so a stocked passage
  // could under-serve the level the button was asking for. One function, called by both.
  for (const theta of [0.1, 0.25, 0.4, 0.5, 0.6, 0.8, 0.95]) {
    const level = targetBriefLevel(theta);
    assert.ok(["A2", "B1", "B2"].includes(level), `${theta} → ${level}`);
  }
});
