/**
 * The rubric that generated content has to pass.
 *
 * A generator without an acceptance test has no quality story, and its failures are silent: text
 * that is too hard, or that the glossary cannot translate, reaches the learner and looks fine in the
 * database. These pin the properties a reader would notice.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RUBRIC_LIMITS, bandFor, checkParagraph, measureParagraph } from "../src/lib/content/rubric";
import type { CefrLevel } from "../src/lib/lang";

/** A candidate of `count` distinct words, all at one difficulty. */
function words(count: number, difficulty: number, prefix = "w") {
  return Array.from({ length: count }, (_, i) => ({ lemmaKey: `${prefix}${i}`, kind: "word" }));
}
const at = (difficulty: number) => () => difficulty;
const glossed = () => true;

test("a text aimed at a level passes at that level", () => {
  // A text with *no* new words is revision, not i+1: the count band rejects it, deliberately (§ the
  // "too few unknown words" case below). This is the shape a real passage has — mostly at the level,
  // with a handful just above it — and the length matters: five unknown words in fifty would drop
  // coverage under the floor, which is why real passages run 90-130 words.
  const { centre } = bandFor("A2");
  const tokens = [
    ...words(95, centre, "known"),
    ...words(5, centre + 0.25, "hard"), // pKnown ~0.78, just under the unknown threshold
  ];
  const result = checkParagraph(tokens, {
    level: "A2",
    difficultyOf: (key) => (key.startsWith("known") ? centre : centre + 0.25),
    hasGloss: glossed,
  });
  assert.equal(result.metrics.unknownCount, 5, "five words the reader does not know");
  assert.ok(result.passed, result.issues.join("; "));
  assert.equal(result.metrics.measuredLevel, "A2");
  assert.ok(result.metrics.coverage >= RUBRIC_LIMITS.minCoverage, "and it stays readable");
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
  // 95 common words and 5 above the reader: the proportion a real text has, and enough new material
  // that the text is not pure revision.
  //
  // Note *how far* above the reader those five have to be for a B2 reader not to know them: with
  // `KNOWN_AT_LEVEL = 0.95`, the unknown threshold sits about 1.4 bands above the reader, so a B2
  // text can only carry unknown words near the top of the axis. That is a property of the model, and
  // it is why the count band is easy to satisfy at A2 and demanding at B2.
  const { centre } = bandFor("B2");
  const tokens = [...words(95, 0.1, "easy"), ...words(5, 1.0, "hard")];
  const result = checkParagraph(tokens, {
    level: "B2",
    difficultyOf: (key) => (key.startsWith("easy") ? 0.1 : 1.0),
    hasGloss: glossed,
  });
  assert.equal(result.metrics.unknownCount, 5);
  assert.ok(result.passed, result.issues.join("; "));
  assert.ok(result.metrics.medianDifficulty < 0.2, "the median word is far below the level");
  void centre;
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

// ── topic vocabulary proposal ─────────────────────────────────────────────────
//
// The model proposes the words a topic needs; the data decides whether they are simple enough. The
// parsing is the part that can be tested without a network.

import { parseGenerated, parseTopicVocabulary } from "../src/scripts/generate/prompt";

test("a proposed word list is read, fenced or not", () => {
  assert.deepEqual(parseTopicVocabulary('{"words": ["Blume", "gießen"]}'), ["Blume", "gießen"]);
  assert.deepEqual(parseTopicVocabulary('```json\n{"words": ["Blume"]}\n```'), ["Blume"]);
});

test("junk in a proposal is dropped rather than passed to the database", () => {
  const parsed = parseTopicVocabulary('{"words": ["Blume", 42, "", "   ", null, "ok"]}');
  assert.deepEqual(parsed, ["Blume", "ok"]);

  // A runaway entry is not a word, and looking it up would only add noise.
  const long = parseTopicVocabulary(`{"words": ["${"x".repeat(60)}", "Blume"]}`);
  assert.deepEqual(long, ["Blume"]);
});

test("an unusable proposal yields nothing, so the sampled list is used instead", () => {
  assert.deepEqual(parseTopicVocabulary("I suggest: Blume, Wasser"), []);
  assert.deepEqual(parseTopicVocabulary(""), []);
  assert.deepEqual(parseTopicVocabulary('{"words": "Blume"}'), []);
});

test("a reply cut off mid-JSON is salvaged rather than thrown away", () => {
  // The second most common failure: the model reaches the content and runs out of budget. The text
  // is there; only the punctuation is missing. The length guard keeps it from salvaging a fragment
  // too short to be a passage at all.
  const truncated =
    '{"title": "Der Zug", "content": "Der Zug hat heute zwanzig Minuten Verspätung. Ich warte auf dem ' +
    'Bahnsteig und schaue auf die Uhr. Ein Mann neben mir sagt, dass der späte Zug ruhiger ist.';

  const salvaged = parseGenerated(truncated);
  assert.ok(salvaged, "a truncated reply should still yield its passage");
  assert.equal(salvaged!.title, "Der Zug");
  assert.match(salvaged!.content, /^Der Zug hat heute zwanzig Minuten/);

  // The guard applies to salvage specifically: a truncated fragment too short to be a passage is
  // not rescued into one. (Valid JSON is returned whatever its length — the rubric rejects a text
  // that short, which is the right place for that judgement.)
  assert.equal(parseGenerated('{"title": "T", "content": "Zu kurz'), null);
});

test("escapes in a salvaged passage are decoded", () => {
  const truncated =
    '{"title": "T", "content": "Er sagt: \\"Guten Morgen, wie geht es Ihnen heute?\\" Dann nimmt er ' +
    'seine Tasche und geht langsam zur Tür."}';
  const salvaged = parseGenerated(truncated);
  assert.ok(salvaged);
  assert.match(salvaged!.content, /^Er sagt: "Guten Morgen/);
  assert.ok(!salvaged!.content.includes('\\"'), "the escaped quotes are decoded, not left in");
});

test("the i+1 check counts unknown words, and reports the band in words", () => {
  // A reader at the band centre meets 5-10 unknown words. Coverage is the floor beneath that, not
  // the target: this is the same judgement stated as a count the reader can act on.
  const level: CefrLevel = "A2";
  const { centre } = bandFor(level);
  // Difficulty exactly at the centre → pKnown 0.95 → known. Above it, unknown.
  const known = centre;
  const unknown = centre + 0.35; // comfortably under pKnown 0.8

  const tokens = [
    ...Array.from({ length: 96 }, () => ({ lemmaKey: "known", kind: "word" })),
    ...Array.from({ length: 6 }, (_, i) => ({ lemmaKey: `hard${i}`, kind: "word" })),
  ];
  const difficultyOf = (key: string) => (key === "known" ? known : unknown);
  // 96 known + 6 unknown in a 102-word passage measures ~94.1% coverage — in the band and above the
  // floor at the same time, which is the narrow window this rule lives in.
  const verdict = checkParagraph(tokens, { level, difficultyOf, hasGloss: () => true });
  assert.equal(verdict.metrics.unknownCount, 6, "six distinct unknown lemmas");
  assert.ok(
    verdict.issues.every((issue) => !issue.includes("unknown words")),
    `a passage in the band should not be rejected for its count: ${verdict.issues.join("; ")}`,
  );
});

test("the unknown count is reported rather than gated", () => {
  const level: CefrLevel = "B1";
  const { centre } = bandFor(level);
  // 100 tokens, none above the reader's level: the B1/B2 case that measured 0-2 unknown words.
  const tokens = Array.from({ length: 100 }, (_, i) => ({ lemmaKey: `w${i}`, kind: "word" }));
  const verdict = checkParagraph(tokens, {
    level,
    difficultyOf: () => centre,
    hasGloss: () => true,
  });
  assert.equal(verdict.metrics.unknownCount, 0);
  assert.equal(
    verdict.passed,
    true,
    "the count is reported, not gated: as a gate it rejected every level (see checkParagraph)",
  );
  assert.ok(
    verdict.issues.every((issue) => !issue.includes("unknown words")),
    "and it must not appear as an issue",
  );
});

test("a high unknown count is still reported", () => {
  const level: CefrLevel = "A2";
  const { centre } = bandFor(level);
  const tokens = [
    ...Array.from({ length: 80 }, (_, i) => ({ lemmaKey: `k${i}`, kind: "word" })),
    ...Array.from({ length: 12 }, (_, i) => ({ lemmaKey: `h${i}`, kind: "word" })),
  ];
  const verdict = checkParagraph(tokens, {
    level,
    difficultyOf: (key) => (key.startsWith("h") ? centre + 0.35 : centre),
    hasGloss: () => true,
  });
  assert.equal(verdict.metrics.unknownCount, 12, "the count is measured");
  assert.ok(
    verdict.issues.every((issue) => !issue.includes("unknown words")),
    "but a high count alone does not reject a passage — only coverage does",
  );
});
