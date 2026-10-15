/**
 * Placement test: generation, scoring, and the guessing correction.
 *
 * The point of the test is the cold start the old model had none of, and the point of the
 * pseudowords is that "yes" is cheap. Both are pinned here.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  PSEUDOWORDS,
  REAL_WORDS,
  generatePseudowords,
  scorePlacement,
  seedFrom,
  type PlacementItem,
} from "../src/lib/learner/placement";
import { probabilityYes } from "../src/lib/learner/ability";

const vocabulary = new Set([
  "wasser", "haus", "baum", "zeit", "wort", "lesen", "gehen", "kommen", "gut", "garten",
  "freund", "arbeit", "morgen", "abend", "kind", "buch", "tisch", "stuhl", "fenster", "tür",
]);

test("pseudowords are plausible in shape and never real words", () => {
  const donors = [...vocabulary];
  const fakes = generatePseudowords({
    count: PSEUDOWORDS,
    seed: seedFrom("test-de"),
    donors,
    // The whole lexicon stands in for the real check; here, the sampled vocabulary.
    isRealWord: (candidate) => vocabulary.has(candidate),
  });

  assert.equal(fakes.length, PSEUDOWORDS, "the generator must fill the quota");
  assert.equal(new Set(fakes).size, fakes.length, "no duplicates");
  for (const fake of fakes) {
    assert.ok(fake.length >= 4, `${fake} is too short to be plausible`);
    assert.equal(vocabulary.has(fake), false, `${fake} is a real word — it would test the opposite`);
    assert.match(fake, /^[a-zäöü]+$/, `${fake} must stay pronounceable`);
  }
});

test("generation is seeded, so a retake is comparable", () => {
  const options = {
    count: 10,
    donors: ["wasser", "haus", "garten", "freund", "arbeit"],
    isRealWord: (c: string) => vocabulary.has(c),
  };
  const a = generatePseudowords({ ...options, seed: 42 });
  const b = generatePseudowords({ ...options, seed: 42 });
  const c = generatePseudowords({ ...options, seed: 43 });
  assert.deepEqual(a, b, "the same seed reproduces the same test");
  assert.notDeepEqual(a, c, "a different seed does not");
  assert.equal(seedFrom("x") === seedFrom("x"), true);
  assert.notEqual(seedFrom("en"), seedFrom("de"));
});

test("a learner who knows the easy words and claims none of the fakes scores above zero", () => {
  // Threshold at difficulty 0.5: knows everything easier, denies everything harder.
  const items: PlacementItem[] = [];
  for (let i = 0; i < REAL_WORDS; i += 1) {
    items.push({ id: `r${i}`, text: `w${i}`, isPseudoword: false, difficulty: i / REAL_WORDS });
  }
  for (let i = 0; i < PSEUDOWORDS; i += 1) {
    items.push({ id: `p${i}`, text: `z${i}`, isPseudoword: true });
  }
  const responses = [
    ...items.filter((i) => !i.isPseudoword).map((i) => ({ id: i.id, yes: (i.difficulty ?? 1) < 0.5 })),
    ...items.filter((i) => i.isPseudoword).map((i) => ({ id: i.id, yes: false })),
  ];

  const score = scorePlacement(items, responses);
  assert.equal(score.falseAlarms, 0);
  assert.equal(score.falseAlarmRate, 0);
  assert.ok(score.hits > 30 && score.hits < 36, `hits=${score.hits}`);
  assert.ok(score.estimate.theta > 0.35 && score.estimate.theta < 0.65, `θ=${score.estimate.theta}`);
  assert.ok(score.dPrime > 2, `a clean separation should give a high d′ (${score.dPrime})`);
});

test("claiming every pseudoword is corrected, not rewarded", () => {
  // The failure the pseudowords exist for: a learner who says yes to everything knows nothing.
  const items: PlacementItem[] = [];
  for (let i = 0; i < REAL_WORDS; i += 1) {
    items.push({ id: `r${i}`, text: `w${i}`, isPseudoword: false, difficulty: 0.1 + (i / REAL_WORDS) * 0.8 });
  }
  for (let i = 0; i < PSEUDOWORDS; i += 1) {
    items.push({ id: `p${i}`, text: `z${i}`, isPseudoword: true });
  }
  const allYes = items.map((i) => ({ id: i.id, yes: true }));

  const score = scorePlacement(items, allYes);
  assert.equal(score.hits, REAL_WORDS);
  assert.equal(score.falseAlarms, PSEUDOWORDS);
  assert.equal(score.falseAlarmRate, 1);
  assert.equal(score.corrected, REAL_WORDS - PSEUDOWORDS, "the protocol's headline penalty");
  // d′ is not exactly zero here, and should not be asserted as such: the log-linear correction uses
  // (x + 0.5)/(N + 1), and the two halves of the test have different N — 67 real words against 33
  // pseudowords — so a ceiling response leaves a small residual. What matters is that it is low,
  // while the *estimate* refuses to call it ability (asserted below).
  assert.ok(score.dPrime < 0.5, `saying yes to everything carries almost no signal (d′=${score.dPrime})`);
  // A floor of 1 means the responses carry no information, and the estimate must say so rather than
  // turn yes-saying into ability.
  assert.ok(score.estimate.theta < 0.75, `θ=${score.estimate.theta} must not be top of the scale`);
  assert.equal(score.estimate.level, null, "claiming everything cannot earn a level");
  assert.ok(score.estimate.se > 0.2, `the interval must be wide (se=${score.estimate.se})`);
});

test("the guessing floor is the learner's own false-alarm rate", () => {
  // A constant 1/3 would be a three-option quiz; a yes/no test has to measure its own.
  assert.equal(probabilityYes(0.5, 0.5, 0), 0.5);
  assert.ok(probabilityYes(-5, 0.5, 0.3) > 0.29, "an unknown word is still claimed sometimes");
  assert.ok(probabilityYes(5, 0.5, 0.3) < 1, "and a known word is not a certainty");
});

test("a perfect score still produces a level, and an empty set does not crash", () => {
  const items: PlacementItem[] = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i}`,
    text: `w${i}`,
    isPseudoword: false,
    difficulty: 0.1 + (i / 20) * 0.8,
  }));
  const perfect = scorePlacement(items, items.map((i) => ({ id: i.id, yes: true })));
  assert.equal(perfect.hits, 20);
  assert.ok(perfect.estimate.theta > 0.8);

  const empty = scorePlacement([], []);
  assert.equal(empty.hits, 0);
  assert.equal(empty.falseAlarmRate, 0);
  assert.equal(empty.estimate.n, 0);
});
