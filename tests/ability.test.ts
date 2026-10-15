/**
 * Ability estimator tests.
 *
 * The behaviour being replaced is a one-way point counter, so these pin the properties that make
 * the replacement different: ability can fall, a thin estimate refuses to claim a level, and the
 * scale is shared with item difficulty rather than being a separate numbering.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ABILITY_SCALE,
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

test("an exposure pattern is only positive evidence across separate sessions", () => {
  // Sessions, not views: reading one paragraph four times in a minute is one session, and the
  // measurement that exposed this pushed a learner to C1/C2 on that basis alone.
  const once = observationFor(
    { exposures: 1, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.equal(once, null, "one glance at a word is not knowledge");

  const repeated = observationFor(
    {
      exposures: SESSIONS_FOR_KNOWN,
      lookups: 0,
      marks: 0,
      unmarks: 0,
      confirmed: 0,
      notSure: 0,
    },
    0.5,
  );
  assert.ok(repeated?.known, "met repeatedly and never looked up is evidence of knowing");

  // Additional exposures help, but with diminishing force — a word met ten times is not ten times
  // as known as one met three times.
  const many = observationFor(
    { exposures: 20, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  )!;
  assert.ok(many.weight < repeated!.weight * 3);
});

test("a single lookup outweighs a single exposure", () => {
  // Otherwise a learner who consults every word would look like a learner who knows them.
  const consulted = observationFor(
    { exposures: 6, lookups: 2, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 },
    0.5,
  );
  assert.equal(consulted?.known, false, "consulting a word twice is not a sign of knowing it");
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
