/**
 * Popover placement.
 *
 * The preview sat "in the middle of the window" because it was positioned with a `bottom` offset
 * derived from the viewport height: `bottom: winHeight - rect.top + 8`. That anchors the popover
 * *above* the word, and any drift in the term (a stale viewport height, a hidden tab, a resize)
 * moves or drops the offset entirely — with `bottom` unset or invalid, a fixed element stays at its
 * static position inside the paragraph flow, which reads as "floating in the middle".
 *
 * So placement is computed here as an explicit top-left corner from the word's own rect, and the
 * arithmetic is pure so it can be tested without a browser. The word's box is the only input that
 * has to be right at render time.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  /** Final left edge, already centred on the word and clamped to the viewport. */
  left: number;
  /** Final top edge. */
  top: number;
  placement: "below" | "above";
}

export interface PlaceOptions {
  anchor: Rect;
  viewport: Size;
  popover: Size;
  /** Distance between the word and the popover. */
  gap?: number;
  /** Smallest distance to keep from the viewport edges. */
  margin?: number;
}

/** Fallback before the popover has been measured, so the first frame is already close. */
export const DEFAULT_POPOVER: Size = { width: 280, height: 150 };

export function placePopover({
  anchor,
  viewport,
  popover,
  gap = 8,
  margin = 8,
}: PlaceOptions): Placement {
  const anchorBottom = anchor.top + anchor.height;
  const below = anchorBottom + gap;
  const above = anchor.top - gap - popover.height;

  const roomBelow = viewport.height - margin - anchorBottom;
  const roomAbove = anchor.top - margin;

  // Prefer below the word, as a reading aid should. Flip above only when below genuinely does not
  // fit, and if neither fits take whichever side has more room rather than overflowing blindly.
  let placement: "below" | "above";
  if (popover.height <= roomBelow) placement = "below";
  else if (popover.height <= roomAbove) placement = "above";
  else placement = roomBelow >= roomAbove ? "below" : "above";

  const rawTop = placement === "below" ? below : above;
  const maxTop = Math.max(margin, viewport.height - margin - popover.height);
  const top = Math.min(Math.max(rawTop, margin), maxTop);

  // Centre on the word, then keep the whole popover on screen. Clamping the final left edge is
  // what stops a word near the margin from pushing the popover half off the viewport.
  const centred = anchor.left + anchor.width / 2 - popover.width / 2;
  const maxLeft = Math.max(margin, viewport.width - margin - popover.width);
  const left = Math.min(Math.max(centred, margin), maxLeft);

  return { left, top, placement };
}
