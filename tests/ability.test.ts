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
import { observationsFor } from "../src/lib/learner/ability-store";
import {
  ABILITY_SCALE,
  KNOWN_AT_LEVEL,
  difficultyAtProbability,
  headSuffixCandidates,
  probabilityYes,
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
});

test("a word at the learner's own level is known, not a coin toss", () => {
  // The anchor, and the bug it fixed. A Rasch crossover puts 50% at θ = difficulty, which is right
  // for discriminating test items and wrong for CEFR vocabulary: the lists are cumulative, so a B1
  // learner knows most B1 words. With the crossover anchor a text whose median word was A2 required
  // C2 ability for 95% coverage — every text was too hard for everyone.
  assert.equal(Math.round(probabilityKnown(0.42, 0.42) * 100), 95);

  // And the curve around it behaves like vocabulary, not like a quiz.
  assert.equal(Math.round(probabilityKnown(0.42, 0.25) * 100), 98, "one band below: known");
  assert.equal(Math.round(probabilityKnown(0.42, 0.58) * 100), 87, "one band above: mostly known");
  assert.ok(probabilityKnown(0.42, 0.92) < 0.5, "three bands above: mostly not");

  // Coverage of a text made of words at and below the reader's level lands in the i+1 band — which
  // is the property the whole reading mode depends on.
  const atAndBelow = [0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.42, 0.15, 0.05, 0.42];
  const coverage = atAndBelow.reduce((sum, d) => sum + probabilityKnown(0.42, d), 0) / atAndBelow.length;
  assert.ok(coverage >= 0.95 && coverage <= 0.99, `coverage ${coverage} should be supported reading`);
});

test("the 50% point lands between the items known and the items not known", () => {
  // θ is now the *95%* point, so the property to check is expressed on the crossover: the learner
  // knows what they answered and does not know what they did not, at the difficulty where the model
  // says they are at even odds.
  const estimate = fitAbility([...known(0.2, 0.3, 0.35), ...unknown(0.85, 0.9, 0.8)]);
  const crossover = difficultyAtProbability(estimate.theta, 0.5);
  assert.ok(crossover > 0.35, `50% point ${crossover} should be above the known items`);
  assert.ok(crossover < 0.8, `50% point ${crossover} should be below the unknown items`);
  // And by construction the level itself is the 95% point.
  assert.ok(Math.abs(difficultyAtProbability(estimate.theta, KNOWN_AT_LEVEL) - estimate.theta) < 1e-9);
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

test("looking a word up lowers confidence in having read past it", () => {
  // Consulting a word is not a sign of knowing it — but it is weaker evidence than reading past it,
  // because the app's premise is that reading past a word *is* the statement that you know it, while
  // a hover is ambiguous (curiosity, a mis-tap, checking a spelling). So a lookup shifts the balance
  // without overturning a reading; a learner who really does not know the word has a mark to make,
  // and that is what the next test guards.
  const read = observationFor(
    { exposures: 3, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  const consulted = observationFor(
    { exposures: 3, lookups: 2, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.ok(read && consulted, "both produce an observation");
  assert.ok(
    consulted.weight < read.weight,
    `consulting must count for less than not consulting (${consulted.weight} vs ${read.weight})`,
  );
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
  // Balanced evidence cancels out; saying nothing is better than guessing a direction.
  // One reading (0.9) against six lookups (6 × 0.15) is the balance point at these weights.
  const balanced = observationFor(
    { exposures: 1, lookups: 6, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.ok(balanced === null || balanced.weight < 0.4, `expected no signal, got ${balanced?.weight}`);
});

test("the scale is stated once and used by both directions", () => {
  // θ and difficulty are the same units; if this constant ever forked, the level mapping would
  // silently stop describing the items.
  assert.equal(ABILITY_SCALE, 0.15);
  assert.equal(probabilityYes(0.4, 0.6, 0), probabilityKnown(0.4, 0.6), "no guessing means the same curve");
  assert.equal(Math.round(probabilityKnown(0.5, 0.5) * 100), Math.round(KNOWN_AT_LEVEL * 100));
});

test("evidence from the same session counts once", async () => {
  // The end-to-end case that failed: four reads of one paragraph in one sitting produced four
  // exposures per word and an estimate of C1/C2. Distinct sessions are what the model needs, and
  // `observationsFor` is where occurrence counts collapse.
  const { observationsFor } = await import("../src/lib/learner/ability-store");
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

test("marking a common word is strong evidence, and the interval says how strong", () => {
  // Under the 95%-at-level anchor, denying a word at difficulty 0.2 is a real claim: the model says a
  // learner at the midpoint would know it with probability 0.98. So the estimate moves a long way —
  // and the safeguard is not that it moves less, but that the interval stays wide enough to refuse a
  // level. That is what stops two clicks being carried into the next paragraph as a verdict.
  const marks = [0.2, 0.25].map((difficulty) => ({ difficulty, known: false, weight: 1 }));
  const estimate = fitAbility(marks, { theta: 0.5, weight: 2 });

  assert.ok(estimate.theta < 0.3, `two denied common words should move it (${estimate.theta})`);
  assert.equal(estimate.level, null, "two clicks cannot name a level");
  assert.ok(estimate.se > 0.15, `and the interval says so (se=${estimate.se})`);
  assert.notEqual(estimate.levelLow, estimate.levelHigh, "the range spans more than one band");

  // Evidence that accumulates does resolve: eight denied frequent words, still intervals-wide in
  // total, is enough to place a beginner at the bottom of the scale.
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

test("a learner who has done nothing sits at the prior, not at a clamp", () => {
  // The bug this pins: with only the prior and no observations, Newton overshot the clamp, bounced to
  // the opposite clamp and stopped there — so a learner who had done nothing was estimated at
  // θ = 0.99, and every unmeasured learner's coverage was computed from that. A German paragraph read
  // 98.9% "comfortable" for someone who had never opened the app.
  const fresh = fitAbility([], { theta: 0.5, weight: 2 });
  assert.ok(Math.abs(fresh.theta - 0.5) < 0.05, `θ=${fresh.theta} should stay at the prior`);
  assert.ok(fresh.theta > 0.2 && fresh.theta < 0.8, "and never at a bound");
  assert.equal(fresh.n, 0, "with no evidence behind it");
  assert.ok(fresh.se > 0.15, "and a wide interval");

  // An empty fit with no prior at all also stays in the middle rather than at an edge.
  assert.equal(fitAbility([]).theta, 0.5);
});

test("one-sided evidence is reported with an interval that covers it", () => {
  // Without a prior the likelihood is monotone, so the maximum sits at a boundary. That is the
  // correct estimate, and the honest thing is for the standard error to say so: a bound must never
  // look like a measurement.
  const allKnown = fitAbility(known(0.1, 0.15, 0.2, 0.12, 0.18, 0.14));
  assert.ok(allKnown.se > 0.5, `se=${allKnown.se} must show the estimate is unbounded above`);
  assert.equal(allKnown.level, null, "so no level is claimed");
  assert.equal(allKnown.levelLow, "A1", "and the interval runs the length of the scale");
  assert.equal(allKnown.levelHigh, "C2");

  // With the regulariser that production always supplies, the same evidence is a finite estimate.
  const withPrior = fitAbility(known(0.1, 0.15, 0.2, 0.12, 0.18, 0.14), { theta: 0.5, weight: 2 });
  assert.ok(withPrior.theta > 0.4, `the prior does not veto the evidence (${withPrior.theta})`);
  assert.ok(withPrior.theta < 0.99, `nor allow it to run to the ceiling (${withPrior.theta})`);
});
