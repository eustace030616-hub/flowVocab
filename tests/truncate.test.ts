import { strict as assert } from "node:assert";
import { test } from "node:test";

import { truncateWords } from "../src/lib/ui/truncate";

test("a heading keeps three words and marks what it dropped", () => {
  // An older passage's topic is a plot, and it pushes the row's other contents off the line.
  assert.equal(
    truncateWords("The coffee machine at work stops working"),
    "The coffee machine…",
  );
  assert.equal(truncateWords("Nature"), "Nature", "a domain is already short enough");
  assert.equal(truncateWords("City life"), "City life");
  assert.equal(truncateWords("drei kurze Wörter"), "drei kurze Wörter");
  assert.equal(truncateWords("drei kurze Wörter hier"), "drei kurze Wörter…");
  assert.equal(truncateWords("   "), "", "nothing in, nothing out");
  assert.equal(truncateWords("a  b   c"), "a  b   c", "whitespace does not inflate the count");
});
