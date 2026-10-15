/**
 * The wording of coverage.
 *
 * Both faults these pin were visible on screen and neither was caught by the coverage tests, because
 * the arithmetic was right and the *presentation* was wrong.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { coverageLabel } from "../src/lib/ui/coverage-label";

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
