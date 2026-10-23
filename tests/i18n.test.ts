/**
 * Both locales carry the same keys.
 *
 * A missing key renders as nothing at all, which is not a visible error — the History button in
 * Chinese mode showed only its count, because `history` existed in English and not in Chinese. The
 * failure looks like a layout mistake, so it is worth a test rather than an eye.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Pull the two locale objects out of `page.tsx` — they are plain object literals, so a slice is
 *  enough, and this keeps the test independent of how the file is otherwise structured. */
function localeKeys(source: string, name: "en" | "zh"): string[] {
  const start = source.indexOf(`  ${name}: {`);
  assert.ok(start > 0, `locale ${name} not found`);
  const body = source.slice(start, source.indexOf("\n  },", start));
  return [...body.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
}

test("every string exists in both locales", () => {
  const source = readFileSync("components/FlowwingApp.tsx", "utf-8");
  const en = new Set(localeKeys(source, "en"));
  const zh = new Set(localeKeys(source, "zh"));

  assert.ok(en.size > 50, `expected the English locale to be substantial, got ${en.size}`);
  assert.deepEqual(
    [...en].filter((k) => !zh.has(k)),
    [],
    "keys missing from Chinese render as nothing",
  );
  assert.deepEqual([...zh].filter((k) => !en.has(k)), [], "keys missing from English");
});

/**
 * Every label the interface asks for exists.
 *
 * `UI` is typed `Record<string, string>`, so `t.returnToLive` compiles whether or not the key is there —
 * and a missing key renders an empty button, which is indistinguishable from a layout bug. Two of them
 * shipped that way: the Return and List controls in a stored passage, with no text at all.
 */
test("every t.* used in the component has a label", () => {
  const source = readFileSync("components/FlowwingApp.tsx", "utf-8");
  const en = new Set(localeKeys(source, "en"));
  const zh = new Set(localeKeys(source, "zh"));

  // Only the identifiers used as labels: `t.` followed by a word, not `t.tracks.map` or `set`.
  const used = new Set([...source.matchAll(/\bt\.([a-zA-Z][a-zA-Z0-9]*)\b/g)].map((m) => m[1]));
  assert.ok(used.size > 30, `expected the component to use many labels, found ${used.size}`);

  const missing = [...used].filter((key) => !en.has(key) || !zh.has(key));
  assert.deepEqual(missing, [], "these labels would render as empty text");
});
