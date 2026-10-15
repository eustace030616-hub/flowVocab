/**
 * The rubric that generated content has to pass.
 *
 * A generator without an acceptance test has no quality story, and its failures are silent: text
 * that is too hard, or that the glossary cannot translate, reaches the learner and looks fine in the
 * database. These pin the properties a reader would notice.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RUBRIC_LIMITS, checkParagraph, measureParagraph } from "../src/lib/content/rubric";

/** A candidate of `count` distinct words, all at one difficulty. */
function words(count: number, difficulty: number, prefix = "w") {
  return Array.from({ length: count }, (_, i) => ({ lemmaKey: `${prefix}${i}`, kind: "word" }));
}
const at = (difficulty: number) => () => difficulty;
const glossed = () => true;

test("a text aimed at a level passes at that level", () => {
  // Fifty words at difficulty 0.25 is A2: a reader at A2 knows nearly all of them, which is i+1.
  const result = checkParagraph(words(50, 0.25), {
    level: "A2",
    difficultyOf: at(0.25),
    hasGloss: glossed,
  });
  assert.ok(result.passed, result.issues.join("; "));
  assert.equal(result.metrics.measuredLevel, "A2");
  assert.ok(result.metrics.coverage > 0.9, "a reader at the level should know most of it");
});

test("the same text fails at a level it is not written for", () => {
  // The silent failure the rubric exists for: correct-looking content mislabelled. A1 words offered
  // to a C1 reader are not i+1, they are revision; C2 words to an A1 reader are a wall.
  const easyText = words(50, 0.05, "e");
  const easyForC1 = checkParagraph(easyText, { level: "C1", difficultyOf: at(0.05), hasGloss: glossed });
  assert.equal(easyForC1.passed, false);
  assert.ok(easyForC1.issues.some((i) => i.includes("too easy")), easyForC1.issues.join("; "));

  const hardText = words(50, 0.8, "h");
  const hardForA1 = checkParagraph(hardText, { level: "A1", difficultyOf: at(0.8), hasGloss: glossed });
  assert.equal(hardForA1.passed, false);
  assert.ok(hardForA1.issues.some((i) => i.includes("harder than it claims")), hardForA1.issues.join("; "));
});

test("a text may be pitched well below the level it is read at", () => {
  // How real texts are built: a B1 text is mostly A1–A2 vocabulary with a minority of B1 words. The
  // rubric must accept that rather than demanding the median word sit at the level, which would
  // reject every natural text ever written.
  // 35 common words and 15 at the level: the proportion a real text has, and enough new material
  // that the text is not pure revision for the reader.
  const tokens = [...words(35, 0.1, "easy"), ...words(15, 0.6, "hard")];
  const result = checkParagraph(tokens, {
    level: "B2",
    difficultyOf: (key) => (key.startsWith("easy") ? 0.1 : 0.6),
    hasGloss: glossed,
  });
  assert.ok(result.passed, result.issues.join("; "));
  assert.ok(result.metrics.medianDifficulty < 0.2, "the median word is far below the level");
  assert.ok(result.metrics.coverage >= 0.95, "and a reader at the level still reads it comfortably");
});

test("text the glossary cannot translate is rejected", () => {
  // The reader's whole job is to explain words. A text whose words have no glosses leaves them with
  // nothing, however well-pitched it is.
  const result = checkParagraph(words(50, 0.25), {
    level: "A2",
    difficultyOf: at(0.25),
    hasGloss: (key) => key !== "w0" && key !== "w1" && key !== "w2" && key !== "w3" && key !== "w4" && key !== "w5" && key !== "w6",
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("untranslatable")), result.issues.join("; "));
});

test("unknown vocabulary counts as unknown rather than being skipped", () => {
  // Half the words are in no dictionary: the reader is on their own with them, so coverage has to
  // fall rather than quietly measuring only the words we happen to hold.
  const tokens = [...words(20, 0.2, "known"), ...words(20, 0.2, "strange")];
  const metrics = measureParagraph(tokens, {
    level: "A2",
    difficultyOf: (key) => (key.startsWith("known") ? 0.2 : undefined),
    hasGloss: glossed,
  });
  assert.equal(metrics.unresolved, 20);
  assert.ok(metrics.coverage < 0.55, `coverage must reflect the unknown half (${metrics.coverage})`);
});

test("length bounds reject fragments and walls of text", () => {
  const short = checkParagraph(words(20, 0.25), { level: "A2", difficultyOf: at(0.25), hasGloss: glossed });
  assert.equal(short.passed, false);
  assert.ok(short.issues.some((i) => i.includes("too short")));

  const long = checkParagraph(words(RUBRIC_LIMITS.maxWords + 10, 0.25), {
    level: "A2",
    difficultyOf: at(0.25),
    hasGloss: glossed,
  });
  assert.equal(long.passed, false);
  assert.ok(long.issues.some((i) => i.includes("too long")));
});

test("punctuation and numbers are not words for rubric purposes", () => {
  const tokens = [
    ...words(50, 0.25),
    { lemmaKey: ",", kind: "punct" },
    { lemmaKey: "12", kind: "number" },
  ];
  const metrics = measureParagraph(tokens, { level: "A2", difficultyOf: at(0.25), hasGloss: glossed });
  assert.equal(metrics.wordTokens, 50);
});

test("an empty candidate is rejected rather than passing vacuously", () => {
  const result = checkParagraph([], { level: "A2", difficultyOf: at(0.25), hasGloss: glossed });
  assert.equal(result.passed, false);
  assert.equal(result.metrics.wordTokens, 0);
});

// ── the coherence judge ───────────────────────────────────────────────────────
//
// The objective rubric passed a passage whose sentences were unrelated to each other — right length,
// right coverage, every word glossed, and unreadable. Difficulty is arithmetic; "is this a text" is
// a judgement, and these pin how the judge's answer is read.

import { parseJudge } from "../src/scripts/generate/prompt";

test("a judge that names its problems is believed", () => {
  const verdict = parseJudge('{"coherent": false, "problems": ["sentences are unrelated"]}');
  assert.equal(verdict.coherent, false);
  assert.deepEqual(verdict.problems, ["sentences are unrelated"]);
});

test("a rejection with no stated problem is not actionable, so it is not looped on", () => {
  // Otherwise the repair step gets "it is incoherent" and regenerates into the same complaint.
  assert.equal(parseJudge('{"coherent": false, "problems": []}').coherent, true);
  assert.equal(parseJudge('{"coherent": false}').coherent, true);
});

test("an unusable judgement passes rather than blocking a text the rubric already accepted", () => {
  assert.equal(parseJudge("I think it is fine!").coherent, true);
  assert.equal(parseJudge("").coherent, true);
  assert.equal(parseJudge("{broken").coherent, true);
});

test("a code-fenced judgement is read", () => {
  const verdict = parseJudge('```json\n{"coherent": false, "problems": ["one long quotation"]}\n```');
  assert.equal(verdict.coherent, false);
  assert.deepEqual(verdict.problems, ["one long quotation"]);
});
