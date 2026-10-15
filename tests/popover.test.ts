/**
 * Popover placement tests.
 *
 * These exist because the bug was a coordinate bug that no API test could see, and no browser was
 * available to eyeball it. The arithmetic is pure, so it can be pinned down exactly.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { placePopover, DEFAULT_POPOVER } from "../src/lib/ui/popover";

const viewport = { width: 1200, height: 900 };

test("the popover sits below the word, centred on it", () => {
  const anchor = { top: 300, left: 400, width: 60, height: 24 };
  const popover = { width: 280, height: 150 };
  const { top, left, placement } = placePopover({ anchor, viewport, popover });

  assert.equal(placement, "below");
  assert.equal(top, 300 + 24 + 8, "8px below the word's bottom edge");
  assert.equal(left, 400 + 30 - 140, "left edge centred on the word's centre");
});

test("it flips above only when there is no room below", () => {
  const popover = { width: 280, height: 150 };
  // Word bottom at 824, so only 900 - 8 - 824 = 68px below — not enough for 150.
  const anchor = { top: 800, left: 400, width: 60, height: 24 };
  const { top, placement } = placePopover({ anchor, viewport, popover });

  assert.equal(placement, "above");
  assert.equal(top, 800 - 8 - 150);
  assert.ok(top + popover.height <= anchor.top, "must not overlap the word");
});

test("it stays below when the popover just fits", () => {
  const popover = { width: 280, height: 150 };
  // 168px of room below, which is more than the 150px popover needs.
  const anchor = { top: 700, left: 400, width: 60, height: 24 };
  const { placement } = placePopover({ anchor, viewport, popover });
  assert.equal(placement, "below");
});

test("it stays below when there is room, even near the bottom", () => {
  const popover = { width: 280, height: 100 };
  const anchor = { top: 700, left: 400, width: 60, height: 24 };
  const { top, placement } = placePopover({ anchor, viewport, popover });

  assert.equal(placement, "below");
  assert.equal(top, 732);
  assert.ok(top + popover.height <= viewport.height - 8);
});

test("a word near the left edge does not push the popover off screen", () => {
  const popover = { width: 280, height: 150 };
  const anchor = { top: 300, left: 2, width: 20, height: 20 };
  const { left } = placePopover({ anchor, viewport, popover });

  assert.equal(left, 8, "clamped to the margin");
  assert.ok(left >= 0);
});

test("a word near the right edge does not push the popover off screen", () => {
  const popover = { width: 280, height: 150 };
  const anchor = { top: 300, left: 1180, width: 18, height: 20 };
  const { left } = placePopover({ anchor, viewport, popover });

  assert.equal(left, viewport.width - 8 - popover.width);
  assert.ok(left + popover.width <= viewport.width);
});

test("when neither side fits it takes the roomier one and stays on screen", () => {
  const popover = { width: 280, height: 500 };
  // Room above = 450 - 8 = 442; room below = 900 - 8 - 474 = 418. Above is roomier.
  const anchor = { top: 450, left: 400, width: 60, height: 24 };
  const { top, placement } = placePopover({ anchor, viewport, popover });

  assert.equal(placement, "above");
  assert.ok(top >= 8);
  assert.ok(top + popover.height <= viewport.height - 8 + 1, "must not overflow the viewport");
});

test("with equal room on both sides the preference for below holds", () => {
  const popover = { width: 280, height: 500 };
  // room above = room below when anchor.top - 8 === 900 - 8 - (anchor.top + height).
  const anchor = { top: 438, left: 400, width: 60, height: 24 };
  const { placement } = placePopover({ anchor, viewport, popover });
  assert.equal(placement, "below");
});

test("a degenerate viewport never produces a negative coordinate", () => {
  // Before the first measurement the viewport can legitimately be 0×0; the result must still be a
  // valid corner, because an unset or NaN left/top drops the element back to its static position.
  const { top, left } = placePopover({
    anchor: { top: 0, left: 0, width: 0, height: 0 },
    viewport: { width: 0, height: 0 },
    popover: DEFAULT_POPOVER,
  });
  assert.ok(Number.isFinite(top) && Number.isFinite(left));
  assert.ok(top >= 0 && left >= 0);
});
