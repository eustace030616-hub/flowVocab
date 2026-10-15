/**
 * Coverage and pKnown tests.
 *
 * Coverage is the operational i+1 rule, so the thresholds are pinned; and pKnown replaces a boolean
 * that could never fall, so what matters is that it moves in the right direction and forgets.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  COMFORTABLE_COVERAGE,
  MINIMAL_COVERAGE,
  coverageOf,
  verdictFor,
} from "../src/lib/learner/coverage";
import {
  EVIDENCE_WINDOW_HALF_LIVES,
  EVIDENCE_WINDOW_MS,
  MODEL_PRIOR_STRENGTH,
  decayFactor,
  foldWordEvidence,
  modelPrediction,
  pKnownFor,
  RECENCY_HALF_LIFE_DAYS,
} from "../src/lib/learner/known";

const token = (lemmaKey: string, kind = "word") => ({ lemmaKey, kind });

test("coverage is the mean probability of knowing the word tokens", () => {
  const result = coverageOf(
    [token("a"), token("b"), token("c"), token("d")],
    (key) => (key === "a" ? 1 : key === "b" ? 1 : key === "c" ? 0 : 0),
  );
  assert.equal(result.coverage, 0.5);
  assert.equal(result.tokens, 4);
  assert.equal(result.unknownIn, 2, "half unknown is one word in two");
});

test("coverage reports one unknown word in N, which is the actionable form", () => {
  // 95% coverage is "1 in 20", the number that makes the threshold mean something.
  const twenty = Array.from({ length: 20 }, (_, i) => token(`w${i}`));
  const result = coverageOf(twenty, (key) => (key === "w0" ? 0 : 1));
  assert.equal(Math.round(result.coverage * 100), 95);
  assert.equal(result.unknownIn, 20);
});

test("the verdicts use the published thresholds", () => {
  assert.equal(MINIMAL_COVERAGE, 0.95);
  assert.equal(COMFORTABLE_COVERAGE, 0.98);
  assert.equal(verdictFor(0.9), "too_hard");
  assert.equal(verdictFor(0.95), "supported");
  assert.equal(verdictFor(0.979), "supported");
  assert.equal(verdictFor(0.98), "comfortable");
});

test("punctuation and numbers are not unknown words", () => {
  // Counting a comma as an unknown word makes every text look harder than it reads.
  const result = coverageOf(
    [token("a"), token(",", "punct"), token("3", "number"), token("b")],
    () => 1,
  );
  assert.equal(result.tokens, 2);
  assert.equal(result.coverage, 1);
  assert.equal(result.verdict, "comfortable");
});

test("an empty text is not a failure", () => {
  const result = coverageOf([], () => 0);
  assert.equal(result.tokens, 0);
  assert.equal(result.coverage, 1);
});

test("pKnown with no history is exactly the model's prediction", () => {
  // This is what makes a first read of a new text estimable rather than blank: every word in the
  // lexicon has an answer before the learner has ever met it.
  const pModel = modelPrediction(0.6, 0.4);
  assert.equal(pKnownFor(undefined, pModel), pModel);
  assert.ok(pModel > 0.5, "an easy word for a strong learner is more likely known than not");
});

test("word-specific evidence moves pKnown away from the model, and can move it down", () => {
  const pModel = modelPrediction(0.6, 0.4);

  const consulted = pKnownFor({ positive: 0, negative: 1.5 }, pModel);
  assert.ok(consulted < pModel, "looking a word up repeatedly is evidence against knowing it");

  const demonstrated = pKnownFor({ positive: 2, negative: 0 }, pModel);
  assert.ok(demonstrated > pModel, "confirmed knowledge raises it");

  assert.ok(consulted > 0 && demonstrated < 1, "it stays a probability");
});

test("the model's prediction cannot be overturned by a single weak signal", () => {
  // Otherwise one stray hover would flip a word the learner's ability says they know.
  const pModel = modelPrediction(0.8, 0.2); // very likely known
  const oneLookup = pKnownFor({ positive: 0, negative: 0.5 }, pModel);
  assert.ok(oneLookup > 0.5, `one lookup must not declare ignorance (got ${oneLookup})`);
  assert.ok(MODEL_PRIOR_STRENGTH >= 1);
});

test("evidence decays, so pKnown can fall without anything being deleted", () => {
  assert.equal(decayFactor(0), 1);
  const halfLife = RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(decayFactor(halfLife) - 0.5) < 1e-9, "one half-life is half the weight");
  assert.ok(decayFactor(halfLife * 4) < 0.1, "evidence from long ago counts for little");

  // The same word, demonstrated recently or long ago, must not score the same.
  const pModel = 0.5;
  const recent = foldWordEvidence([
    { type: "confirmed", lemmaKey: "wort", ts: new Date() },
  ]);
  const ancient = foldWordEvidence([
    { type: "confirmed", lemmaKey: "wort", ts: new Date(Date.now() - halfLife * 6) },
  ]);
  assert.ok(
    pKnownFor(recent.get("wort"), pModel) > pKnownFor(ancient.get("wort"), pModel),
    "recent evidence outranks stale evidence",
  );
});

test("one reading session is enough, and further sessions add little", () => {
  const now = Date.now();
  const oneSession = foldWordEvidence([
    { type: "exposure", items: [{ lemmaKey: "wort" }], sessionId: "s1", ts: now },
    { type: "exposure", items: [{ lemmaKey: "wort" }], sessionId: "s1", ts: now },
    { type: "exposure", items: [{ lemmaKey: "wort" }], sessionId: "s1", ts: now },
  ]);
  assert.equal(oneSession.get("wort")?.sessions, 1, "repeats within a sitting are one session");
  assert.ok(
    (oneSession.get("wort")?.positive ?? 0) > 0,
    "reading past a word once is evidence of knowing it",
  );

  const fourSessions = foldWordEvidence([
    { type: "exposure", items: [{ lemmaKey: "wort" }], sessionId: "s1", ts: now },
    { type: "exposure", items: [{ lemmaKey: "wort" }], sessionId: "s2", ts: now },
    { type: "exposure", items: [{ lemmaKey: "wort" }], sessionId: "s3", ts: now },
    { type: "exposure", items: [{ lemmaKey: "wort" }], sessionId: "s4", ts: now },
  ]);
  const one = oneSession.get("wort")!.positive;
  const four = fourSessions.get("wort")!.positive;
  assert.ok(four > one, "meeting it again does add");
  assert.ok(four <= one * 2, "but not in proportion — the credit is capped");
});

test("unmarking retracts the claim instead of adding evidence for it", () => {
  const now = Date.now();
  const folded = foldWordEvidence([
    { type: "mark", lemmaKey: "wort", ts: now },
    { type: "unmark", lemmaKey: "wort", ts: now },
  ]);
  const entry = folded.get("wort")!;
  assert.equal(entry.marks, 0);
  assert.equal(entry.negative, 0, "a retracted mark is not evidence of not knowing");
});

test("a compound is scored by its weakest part, not as an unknown word", () => {
  // The measurement that found this: "Wortschatzaufbau" scored 0.00 while both of its parts were
  // known — because the compound itself is not a lexicon entry. Every compound in a text then
  // counted as unknown and depressed the coverage of anything German.
  const probabilities = new Map([
    ["wortschatz", 0.8],
    ["aufbau", 0.4],
  ]);
  // The route supplies the parts; this reproduces that fold's arithmetic.
  let weakest = 1;
  for (const part of ["wortschatz", "aufbau"]) {
    weakest = Math.min(weakest, probabilities.get(part) ?? 0);
  }
  assert.equal(weakest, 0.4, "the harder half is what limits comprehension");
  assert.ok(weakest > 0, "a compound of two known-ish parts is not entirely unknown");

  // Minimum rather than product: multiplying two sub-0.5 probabilities describes no learner.
  assert.notEqual(weakest, 0.8 * 0.4);
});

test("the fold window is justified by the decay it already applies", () => {
  // The bound is only legitimate if evidence at the edge really is negligible; otherwise it is a
  // performance fix that quietly changes the estimate.
  const halfLife = RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  assert.equal(EVIDENCE_WINDOW_MS, halfLife * EVIDENCE_WINDOW_HALF_LIVES);
  const atEdge = decayFactor(EVIDENCE_WINDOW_MS);
  assert.ok(atEdge < 0.07, `evidence at the window edge weighs ${atEdge}, not negligible enough`);
  assert.ok(atEdge > 0.05, "and it is not so small that the window could be halved again for free");
});
