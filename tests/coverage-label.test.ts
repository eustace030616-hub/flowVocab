/**
 * The wording of coverage.
 *
 * Both faults these pin were visible on screen and neither was caught by the coverage tests, because
 * the arithmetic was right and the *presentation* was wrong.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { coverageLabel, liveCoverage } from "../src/lib/ui/coverage-label";

test("the percentage and the ratio are derived from the same number", () => {
  // The reported case: the badge read "98% · likely known 1:64". 98% is 1 in 50, so the two figures
  // contradicted each other; they came from different roundings of 0.9844.
  const label = coverageLabel(0.9844);
  assert.equal(label.percent, "98.4");
  // 98.4% displayed ⇒ 1.6% unfamiliar ⇒ 1/0.016 = 62.5 ⇒ 63. Consistent with what is on screen.
  assert.equal(label.oneIn, 63);

  // And the ratio really is implied by the displayed percentage, within rounding.
  const implied = 1 / (1 - Number(label.percent) / 100);
  assert.ok(Math.abs(implied - label.oneIn) <= 1, `${implied} vs ${label.oneIn}`);
});

test("whole-number percentages would hide the differences the number exists to show", () => {
  // Everything from 97.5% to 98.5% renders as "98" at whole-number precision.
  assert.equal(coverageLabel(0.975).percent, "97.5");
  assert.equal(coverageLabel(0.985).percent, "98.5");
  assert.notEqual(coverageLabel(0.975).percent, coverageLabel(0.985).percent);
});

test("full coverage has no ratio to report", () => {
  const label = coverageLabel(1);
  assert.equal(label.percent, "100.0");
  assert.equal(label.oneIn, null, "one unknown word in infinity is not a number to show");
});

test("a ratio never claims less than one word", () => {
  // 99.9% is 1 in 1000; rounding must not produce 1 in 0 or a negative count.
  const label = coverageLabel(0.999);
  assert.equal(label.percent, "99.9");
  assert.ok((label.oneIn ?? 0) >= 1);
});

test("out-of-range and broken values do not produce nonsense", () => {
  assert.equal(coverageLabel(1.4).percent, "100.0");
  assert.equal(coverageLabel(-0.2).percent, "0.0");
  assert.equal(coverageLabel(Number.NaN).percent, "0.0");
});

test("the thresholds read as the verdicts they are labelled with", () => {
  // 95% minimal support, 98% comfortable, from the coverage module.
  assert.equal(coverageLabel(0.95).percent, "95.0");
  assert.equal(coverageLabel(0.95).oneIn, 20, "95% is one unknown word in twenty");
  assert.equal(coverageLabel(0.98).oneIn, 50, "98% is one in fifty");
});

// ── live coverage, while the learner is marking words ─────────────────────────

test("a mark applies to every occurrence of the word", () => {
  // The words that repeat in real text are the function words, so marking one occurrence of "the"
  // and moving only that span under-reported what the learner had just said by most of the text.
  const tokens = [{ lemmaKey: "the" }, { lemmaKey: "dog" }, { lemmaKey: "the" }];
  const p = (k: string) => ({ the: 0.99, dog: 0.9 })[k] ?? 0;

  const before = liveCoverage(tokens, p, new Set());
  const after = liveCoverage(tokens, p, new Set(["the"]));

  assert.ok(before.value > 0.95);
  assert.ok(after.value < before.value);
  // Both occurrences dropped, so the fall is twice one occurrence's worth.
  const oneOccurrence = (0.99 - 0.05) / 3;
  assert.ok(Math.abs((before.value - after.value) - 2 * oneOccurrence) < 1e-9);
});

test("the verdict follows the live figure rather than the loaded one", () => {
  // "90.1% · comfortable" is contradictory: 90% is below the 95% threshold.
  const tokens = Array.from({ length: 20 }, (_, i) => ({ lemmaKey: `w${i}` }));
  const p = () => 1;

  assert.equal(liveCoverage(tokens, p, new Set()).verdict, "comfortable");

  // Marking one word in twenty takes it to 95.25% — supported, not comfortable.
  const one = liveCoverage(tokens, p, new Set(["w0"]));
  assert.ok(one.value < 0.98 && one.value >= 0.95);
  assert.equal(one.verdict, "supported");

  // Marking five takes it below 95% — hard.
  const five = liveCoverage(tokens, p, new Set(["w0", "w1", "w2", "w3", "w4"]));
  assert.ok(five.value < 0.95);
  assert.equal(five.verdict, "too_hard");
});

test("unmarking restores the word, so the badge is reversible", () => {
  const tokens = [{ lemmaKey: "dog" }];
  const p = () => 0.9;
  assert.equal(liveCoverage(tokens, p, new Set(["dog"])).value, 0.05);
  assert.equal(liveCoverage(tokens, p, new Set()).value, 0.9);
});

test("a word with no probability counts as unknown, matching the server", () => {
  const tokens = [{ lemmaKey: "unknown" }];
  assert.equal(liveCoverage(tokens, () => undefined, new Set()).value, 0);
  // And marking it cannot make it worse than unknown.
  assert.equal(liveCoverage(tokens, () => undefined, new Set(["unknown"])).value, 0);
});

test("an empty paragraph does not divide by zero", () => {
  const result = liveCoverage([], () => 0.5, new Set());
  assert.equal(result.value, 1);
  assert.equal(result.percent, "100.0");
});
