/**
 * Meaning-grouping tests.
 *
 * The case these exist for is the reported bug: "train" reaching the learner as 火车 when the word
 * clicked was the verb "trained". The fix is not to guess the reading but to show both, grouped and
 * labelled, which makes the grouping logic worth pinning down.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { groupMeanings, meaningLabel, type Meaning } from "../src/lib/ui/meanings";

const train: Meaning[] = [
  { pos: "noun", termPos: null, text: "火车", source: "cc-cedict" },
  { pos: "verb", termPos: "verb", text: "训练", source: "cc-cedict" },
  { pos: "noun", termPos: null, text: "列车", source: "cc-cedict" },
  { pos: "verb", termPos: "verb", text: "培训", source: "cc-cedict" },
  { pos: "noun", termPos: "verb", text: "训练", source: "cc-cedict" },
  { pos: "verb", termPos: "verb", text: "培育", source: "cc-cedict" },
];

test("readings are grouped by the headword's part of speech", () => {
  // The default cap is covered separately; this asserts the grouping itself.
  const groups = groupMeanings(train, { maxPerGroup: 3, maxGroups: 2 });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].pos, "noun");
  assert.deepEqual(groups[0].texts, ["火车", "列车", "训练"]);
  assert.deepEqual(groups[1].pos, "verb");
  assert.deepEqual(groups[1].texts, ["训练", "培训", "培育"]);
});

test("a group is capped, and duplicate texts within it collapse", () => {
  const many: Meaning[] = [
    { pos: "verb", termPos: "verb", text: "a", source: "s" },
    { pos: "verb", termPos: "verb", text: "a", source: "s" },
    { pos: "verb", termPos: "verb", text: "b", source: "s" },
    { pos: "verb", termPos: "verb", text: "c", source: "s" },
    { pos: "verb", termPos: "verb", text: "d", source: "s" },
  ];
  assert.deepEqual(groupMeanings(many, { maxPerGroup: 2 })[0].texts, ["a", "b"]);
});

test("a part-of-speech label is dropped when the group disagrees", () => {
  // 训练 appears under the noun reading too. Carrying "verb" there would be a claim about one
  // reading presented as a claim about the whole group.
  const groups = groupMeanings(train);
  assert.equal(groups[0].termPos, null, "the noun group mixes a verb-labelled term");
  assert.equal(groups[1].termPos, "verb", "the verb group agrees");
});

test("a single reading yields a single group", () => {
  const groups = groupMeanings([{ pos: "noun", termPos: "noun", text: "狗", source: "cc-cedict" }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].texts, ["狗"]);
});

test("an unlabelled headword still groups under a null part of speech", () => {
  const groups = groupMeanings([{ pos: null, termPos: null, text: "x", source: "s" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pos, null);
});

test("no meanings means no groups, not a crash", () => {
  assert.deepEqual(groupMeanings(undefined), []);
  assert.deepEqual(groupMeanings([]), []);
});

test("one label rule for every case", () => {
  // The preview had three shapes depending on the data: "n 训练" when a headword part of speech
  // was known, "情绪化 adj" when only the term's was, and "- 陪伴" when neither was. One rule now
  // decides the label, and an unknown part of speech is an empty column rather than a dash.
  assert.equal(meaningLabel({ pos: "noun", termPos: "verb", texts: ["火车"] }), "noun");
  assert.equal(meaningLabel({ pos: null, termPos: "adjective", texts: ["情绪化"] }), "adjective");
  assert.equal(meaningLabel({ pos: null, termPos: null, texts: ["陪伴"] }), null);
});

test("a translation appears once, in its labelled group", () => {
  // A curated gloss carries no part of speech and the dictionary entry for the same word does, so
  // "aufstehen" was listed twice: bare, then as "v to get up".
  const groups = groupMeanings([
    { pos: null, termPos: null, text: "to get up", source: "seed" },
    { pos: "verb", termPos: null, text: "to get up", source: "ding" },
    { pos: "verb", termPos: null, text: "to stand up", source: "ding" },
  ]);

  assert.equal(groups.length, 1, "the unlabelled group is emptied and dropped");
  assert.equal(groups[0].pos, "verb");
  assert.deepEqual(groups[0].texts, ["to get up", "to stand up"]);
});

test("an unlabelled translation survives when nothing else carries it", () => {
  const groups = groupMeanings([
    { pos: null, termPos: null, text: "陪伴", source: "seed" },
    { pos: "noun", termPos: null, text: "友谊", source: "cc-cedict" },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].texts, ["陪伴"]);
  assert.deepEqual(groups[1].texts, ["友谊"]);
});

test("readings are capped and ordered by the best-ranked gloss", () => {
  // Several sources each contribute glosses. Without a cap, "verstehen" rendered nine lines —
  // a concordance rather than a hint.
  const meanings: Meaning[] = [
    { pos: "noun", termPos: null, text: "reading", source: "kaikki", rank: 6 },
    { pos: "verb", termPos: null, text: "to read", source: "ding", rank: 1 },
    { pos: "verb", termPos: null, text: "to peruse", source: "kaikki", rank: 7 },
    { pos: "verb", termPos: null, text: "to study", source: "kaikki", rank: 8 },
    { pos: "adjective", termPos: null, text: "well-read", source: "kaikki", rank: 9 },
  ];

  const groups = groupMeanings(meanings);
  assert.equal(groups.length, 2, "at most two readings");
  assert.deepEqual(groups[0].pos, "verb", "the best-ranked reading leads");
  assert.deepEqual(groups[0].texts, ["to read", "to peruse"], "capped at two translations");
  assert.deepEqual(groups[1].pos, "noun");
});

test("the caps can be raised when a caller wants everything", () => {
  const meanings: Meaning[] = [
    { pos: "noun", termPos: null, text: "a", source: "s", rank: 2 },
    { pos: "verb", termPos: null, text: "b", source: "s", rank: 1 },
    { pos: "adjective", termPos: null, text: "c", source: "s", rank: 3 },
  ];
  assert.equal(groupMeanings(meanings, { maxGroups: 3 }).length, 3);
});
