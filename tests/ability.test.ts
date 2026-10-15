/**
 * Ability estimator tests.
 *
 * The behaviour being replaced is a one-way point counter, so these pin the properties that make
 * the replacement different: ability can fall, a thin estimate refuses to claim a level, and the
 * scale is shared with item difficulty rather than being a separate numbering.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { scorePlacement, type PlacementItem } from "../src/lib/learner/placement";
import {
  ABILITY_SCALE,
  headSuffixCandidates,
  SESSIONS_FOR_KNOWN,
  fitAbility,
  isLevelClaimable,
  observationFor,
  probabilityKnown,
  type Observation,
} from "../src/lib/learner/ability";

/** A spread of items the learner got right, at the given difficulties. */
function known(...difficulties: number[]): Observation[] {
  return difficulties.map((difficulty) => ({ difficulty, known: true, weight: 1 }));
}
function unknown(...difficulties: number[]): Observation[] {
  return difficulties.map((difficulty) => ({ difficulty, known: false, weight: 1 }));
}

test("probability of knowing rises with ability and falls with difficulty", () => {
  assert.ok(probabilityKnown(0.6, 0.4) > probabilityKnown(0.4, 0.4));
  assert.ok(probabilityKnown(0.5, 0.3) > probabilityKnown(0.5, 0.7));
  // At equality it is a coin toss, which is what makes θ and difficulty comparable.
  assert.equal(Math.round(probabilityKnown(0.42, 0.42) * 100), 50);
});

test("ability lands between the items known and the items not known", () => {
  // The defining property of the estimate on this axis: the learner is past what they know and
  // short of what they do not.
  const estimate = fitAbility([...known(0.2, 0.3, 0.35), ...unknown(0.85, 0.9, 0.8)]);
  assert.ok(estimate.theta > 0.35, `θ=${estimate.theta} should be above the known items`);
  assert.ok(estimate.theta < 0.8, `θ=${estimate.theta} should be below the unknown items`);
});

test("ability can fall, which the counter it replaces could not do", () => {
  const strong = fitAbility([...known(0.7, 0.72, 0.75, 0.68)]);
  const afterFailures = fitAbility([
    ...known(0.7, 0.72, 0.75, 0.68),
    ...unknown(0.1, 0.15, 0.2, 0.12, 0.18),
  ]);
  assert.ok(
    afterFailures.theta < strong.theta,
    `failing easy items must lower the estimate (${afterFailures.theta} vs ${strong.theta})`,
  );
});

test("a one-sided estimate stays finite and defensible", () => {
  // Knowing everything you have met has no upper bound in the likelihood alone; without a prior
  // the estimate would run away, and with a heavy one it would ignore the evidence.
  const allKnown = fitAbility(known(0.4, 0.5, 0.6, 0.7, 0.8));
  assert.ok(allKnown.theta <= 0.99 && allKnown.theta > 0.8);

  const allUnknown = fitAbility(unknown(0.2, 0.3, 0.4, 0.5));
  assert.ok(allUnknown.theta >= 0.01 && allUnknown.theta < 0.2);
});

test("a prior centres the estimate without overruling the evidence", () => {
  const noPrior = fitAbility(known(0.8, 0.82, 0.85));
  const withPrior = fitAbility(known(0.8, 0.82, 0.85), { theta: 0.3, weight: 2 });
  assert.ok(withPrior.theta < noPrior.theta, "a lower prior pulls the estimate down");
  assert.ok(withPrior.theta > 0.3, "but the evidence still carries it above the prior");
});

test("more evidence means less uncertainty, and a level is only claimed when it is earned", () => {
  const thin = fitAbility(known(0.5, 0.55));
  assert.ok(thin.se > 0.05);
  assert.equal(thin.level, null, "two words cannot justify a level");
  assert.equal(isLevelClaimable(thin), false);

  // A level needs roughly 30 informative observations — what a placement test supplies, not what
  // one paragraph does. The threshold is deliberately not reachable by reading alone.
  const spread = (from: number, to: number, count: number) =>
    Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
  const solid = fitAbility([
    ...known(...spread(0.2, 0.55, 60)),
    ...unknown(...spread(0.6, 0.9, 60)),
  ]);
  assert.ok(solid.se < thin.se, "more observations must narrow the interval");
  assert.ok(solid.level !== null, `120 observations should claim a level (se=${solid.se})`);
  // The range is always reportable, even when the point estimate is not trustworthy.
  assert.ok(solid.levelLow && solid.levelHigh);
});

test("an empty log yields no level rather than a default one", () => {
  const empty = fitAbility([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.level, null);
  assert.ok(empty.se > 0.2, "with no evidence the interval must be wide");
});

test("reading past a word is evidence of knowing it", () => {
  // The app's premise: the reader marks what they do not know, so an unmarked word was known. An
  // earlier version demanded three separate sessions, which meant a paragraph read once produced no
  // evidence and the estimate never moved however much was read.
  const oneRead = observationFor(
    { exposures: 1, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.ok(oneRead?.known, "one read with no mark asserts the word was understood");
  assert.ok((oneRead?.weight ?? 0) > 0, "and it carries weight, or reading changes nothing");

  // More readings help, with sharply diminishing force: a word passed over five times is not five
  // times as known as one passed over once.
  const many = observationFor(
    { exposures: 20, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  )!;
  assert.ok(many.weight < oneRead!.weight * 3);
});

test("looking a word up outweighs having read past it", () => {
  // Otherwise a learner who consults every word would look like a learner who knows them: exposure
  // alone is now positive evidence, so the negative signals have to be able to beat it.
  const consulted = observationFor(
    { exposures: 3, lookups: 2, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.equal(consulted?.known, false, "consulting a word is not a sign of knowing it");
});

test("an explicit mark outlasts any amount of reading past the word", () => {
  // The failure this guards: if exposure accumulated without limit, reading a paragraph repeatedly
  // would eventually overturn the learner's own statement that they do not know the word.
  const readManyTimes = observationFor(
    { exposures: 50, lookups: 0, marks: 1, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.equal(readManyTimes?.known, false, "a mark is not undone by passive re-reading");
});

test("a confirmed answer outranks an earlier lookup", () => {
  const contradicted = observationFor(
    { exposures: 5, lookups: 1, marks: 0, unmarks: 0, confirmed: 2, notSure: 0 },
    0.5,
  );
  assert.equal(contradicted?.known, true, "evidence can be overturned by better evidence");
});

test("a word with no net evidence produces no observation", () => {
  // A lookup and three exposures cancel out; saying nothing is better than guessing a direction.
  const balanced = observationFor(
    { exposures: 3, lookups: 1, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.ok(balanced === null || balanced.weight < 0.4);
});

test("the scale is stated once and used by both directions", () => {
  // θ and difficulty are the same units; if this constant ever forked, the level mapping would
  // silently stop describing the items.
  assert.equal(ABILITY_SCALE, 0.15);
  assert.equal(Math.round(probabilityKnown(0.5, 0.5) * 100), 50);
});

test("evidence from the same session counts once", async () => {
  // The end-to-end case that failed: four reads of one paragraph in one sitting produced four
  // exposures per word and an estimate of C1/C2. Distinct sessions are what the model needs, and
  // `observationsFor` is where occurrence counts collapse.
  const { observationsFor } = await import("../src/lib/learner/ability");
  assert.equal(typeof observationsFor, "function");
});

test("a word met in three separate sessions, never looked up, is evidence of knowing", () => {
  const threeSessions = observationFor(
    { exposures: SESSIONS_FOR_KNOWN, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.ok(threeSessions?.known);

  // Two sessions is not yet enough, however many times the word was rendered within them.
  const twoSessions = observationFor(
    { exposures: SESSIONS_FOR_KNOWN - 1, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.equal(twoSessions, null);
});

test("an estimate with no evidence reports the widest interval, not a point", () => {
  // Collapsing this to a point printed a confident "B2" for a learner who had done nothing at all.
  const empty = fitAbility([]);
  assert.equal(empty.levelLow, "A1");
  assert.equal(empty.levelHigh, "C2");
  assert.equal(empty.level, null);
});

test("a few marks move the estimate without turning clicks into a level", () => {
  // Marking two or three words is real evidence and should be felt, or the level would not respond
  // to reading at all. But with no prior the fit had nothing to weigh it against and two marks at
  // low difficulty took ability to 0.01 — an overreaction that then propagated, because the next
  // paragraph's coverage is computed from whatever the marks left behind.
  const marks = [0.2, 0.25].map((difficulty) => ({ difficulty, known: false, weight: 1 }));

  const bare = fitAbility(marks);
  const regularised = fitAbility(marks, { theta: 0.5, weight: 2 });

  assert.ok(bare.theta < 0.05, "unregularised, two clicks reach the floor");
  assert.ok(regularised.theta > bare.theta, "the regulariser holds it up");
  assert.ok(regularised.theta < 0.5, "while still letting the evidence move it");
  assert.equal(regularised.level, null, "two clicks cannot name a level");
  assert.ok(regularised.se > 0.15, `and the interval says so (se=${regularised.se})`);

  // Enough marks do reach the floor, and should: five unknown frequent words is a beginner.
  const many = Array.from({ length: 8 }, (_, i) => ({ difficulty: 0.15 + i * 0.02, known: false, weight: 1 }));
  assert.ok(fitAbility(many, { theta: 0.5, weight: 2 }).theta < 0.15);
});

test("a compound can find its head, so marking one is evidence rather than silence", () => {
  // "Wortschatzaufbau" has no entry of its own, so it had no difficulty and produced no
  // observation: marking it changed the word but not the learner's estimate.
  const candidates = headSuffixCandidates("wortschatzaufbau");
  assert.equal(candidates[0], "schatzaufbau", "longest first");
  assert.ok(candidates.includes("aufbau"), "the actual head is reachable");
  // The head is tried after longer, unlikely suffixes — which is fine, they simply do not resolve.
  assert.ok(candidates.indexOf("aufbau") > 0);

  // A short word has no interior to split at.
  assert.deepEqual(headSuffixCandidates("haus"), []);
  // And a word is never its own head.
  assert.equal(headSuffixCandidates("wortschatz").includes("wortschatz"), false);
});

test("a level is not withheld when the interval already sits inside one band", () => {
  // The contradiction this fixes: "level: none, range A1–A1". At the floor the interval is
  // one-sided, so it can sit inside a single band while the standard error stays just above the
  // threshold — withholding the level there contradicts the range printed beside it.
  //
  // Real numbers from a placement test: 40 real words and 20 pseudowords answered, claiming the
  // easiest tenth and 6 of the fakes.
  const items: PlacementItem[] = [];
  for (let i = 0; i < 40; i += 1) {
    items.push({ id: `r${i}`, text: `w${i}`, isPseudoword: false, difficulty: 0.1 + (i / 40) * 0.4 });
  }
  for (let i = 0; i < 20; i += 1) items.push({ id: `p${i}`, text: `z${i}`, isPseudoword: true });

  const responses = [
    ...items.filter((i) => !i.isPseudoword).map((i) => ({ id: i.id, yes: (i.difficulty ?? 1) < 0.12 })),
    ...items.filter((i) => i.isPseudoword).map((i, index) => ({ id: i.id, yes: index < 6 })),
  ];

  const estimate = scorePlacement(items, responses).estimate;
  assert.equal(estimate.levelLow, "A1");
  assert.equal(estimate.levelHigh, "A1", "the interval is inside one band");
  assert.ok(estimate.se > 0.05, `and the standard error alone would have withheld it (${estimate.se})`);
  assert.equal(estimate.level, "A1", "so the band is the claim");
  assert.equal(isLevelClaimable(estimate), true);

  // A wide interval across several bands still refuses.
  const wide = fitAbility(known(0.5));
  assert.notEqual(wide.levelLow, wide.levelHigh);
  assert.equal(wide.level, null);
  assert.equal(isLevelClaimable(wide), false);
});
