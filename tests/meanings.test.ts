/**
 * Meaning-grouping tests.
 *
 * The case these exist for is the reported bug: "train" reaching the learner as 火车 when the word
 * clicked was the verb "trained". The fix is not to guess the reading but to show both, grouped and
 * labelled, which makes the grouping logic worth pinning down.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { groupMeanings, type Meaning } from "../src/lib/ui/meanings";

const train: Meaning[] = [
  { pos: "noun", termPos: null, text: "火车", source: "cc-cedict" },
  { pos: "verb", termPos: "verb", text: "训练", source: "cc-cedict" },
  { pos: "noun", termPos: null, text: "列车", source: "cc-cedict" },
  { pos: "verb", termPos: "verb", text: "培训", source: "cc-cedict" },
  { pos: "noun", termPos: "verb", text: "训练", source: "cc-cedict" },
  { pos: "verb", termPos: "verb", text: "培育", source: "cc-cedict" },
];

test("readings are grouped by the headword's part of speech", () => {
  const groups = groupMeanings(train);
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
  assert.deepEqual(groupMeanings(many, 2)[0].texts, ["a", "b"]);
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
