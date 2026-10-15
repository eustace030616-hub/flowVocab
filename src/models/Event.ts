import mongoose, { Schema, Document, models, model } from "mongoose";
import type { TargetLang } from "../lib/lang";

/**
 * The append-only event log — the source of truth for the learner model.
 *
 * The original app mutated `Word.unfamiliarity` in place and *decremented* it when a word was
 * un-clicked, which meant the app could only ever lose evidence: one stray un-click could
 * flip a word to `known`, and the history that would let you undo that was gone.
 *
 * Two signals were never recorded at all, and they matter more than clicks:
 *
 *   exposure   the item was on screen and the learner did NOT click it — the cheapest and
 *              strongest evidence of knowing a word, and previously thrown away entirely
 *   not_sure   the learner explicitly said they were unsure (the mini program collected
 *              this and then scored it as a plain wrong answer)
 *
 * Events are never updated and never deleted by application code. `Word` holds a derived
 * cache of this log; if that cache is ever wrong, it can be recomputed. The reverse is
 * not true.
 */
export type EventType =
  | "exposure"
  | "lookup"
  | "mark"
  | "unmark"
  | "confirmed"
  | "not_sure";

export type EventSource = "web" | "reader" | "placement" | "import";

export interface EventItem {
  surface: string;
  lemmaKey: string;
  charStart?: number;
  charEnd?: number;
}

export interface IEvent extends Document {
  userId: mongoose.Types.ObjectId;
  targetLang: TargetLang;
  type: EventType;
  source: EventSource;

  /** Groups a page-view's worth of events; lets exposure be deduplicated later. */
  sessionId?: string;

  paragraphId?: mongoose.Types.ObjectId;
  wordId?: mongoose.Types.ObjectId;

  /** Single-item events (mark, unmark, lookup, confirmed, not_sure). */
  surface?: string;
  lemmaKey?: string;
  charStart?: number;
  charEnd?: number;

  /**
   * Batched events. One `exposure` event carries every item that was on screen, so viewing a
   * paragraph costs one insert instead of ~60. Query with `items.lemmaKey`.
   */
  items?: EventItem[];

  ts: Date;
  createdAt: Date;
}

const EventItemSchema = new Schema<EventItem>(
  {
    surface: { type: String, required: true },
    lemmaKey: { type: String, required: true },
    charStart: { type: Number },
    charEnd: { type: Number },
  },
  { _id: false },
);

const EventSchema = new Schema<IEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetLang: { type: String, enum: ["en", "de"], required: true },
    type: {
      type: String,
      enum: ["exposure", "lookup", "mark", "unmark", "confirmed", "not_sure"],
      required: true,
    },
    source: { type: String, enum: ["web", "reader", "placement", "import"], default: "web" },

    sessionId: { type: String },

    paragraphId: { type: Schema.Types.ObjectId, ref: "Paragraph" },
    wordId: { type: Schema.Types.ObjectId, ref: "Word" },

    surface: { type: String },
    lemmaKey: { type: String },
    charStart: { type: Number },
    charEnd: { type: Number },

    items: { type: [EventItemSchema] },

    ts: { type: Date, default: Date.now },
  },
  // Append-only: createdAt only, no updatedAt.
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Per-learner, per-language recency — the shape every derivation query uses.
EventSchema.index({ userId: 1, targetLang: 1, ts: -1 });
EventSchema.index({ userId: 1, targetLang: 1, lemmaKey: 1, ts: -1 });
EventSchema.index({ userId: 1, paragraphId: 1, ts: -1 });
// Batched exposures are found by unwinding items.
EventSchema.index({ userId: 1, targetLang: 1, "items.lemmaKey": 1 });

/**
 * Append-only is enforced, not merely documented. An update in application code is a bug:
 * it means the derivation and the log have diverged, and the log is the thing that cannot
 * be rebuilt.
 *
 * Exported so the invariant is unit-testable without a database connection.
 */
export function appendOnlyGuard(options?: { bypassAppendOnly?: boolean }): void {
  if (options?.bypassAppendOnly) return;
  throw new Error(
    "Event is append-only: updates are not permitted. Recompute derived state from the log " +
      "instead (src/lib/learner/state.ts), or pass { bypassAppendOnly: true } for a migration.",
  );
}

function rejectMutation(this: mongoose.Query<unknown, unknown>): void {
  appendOnlyGuard(this.getOptions?.() as { bypassAppendOnly?: boolean } | undefined);
}

EventSchema.pre("updateOne", rejectMutation);
EventSchema.pre("updateMany", rejectMutation);
EventSchema.pre("findOneAndUpdate", rejectMutation);
EventSchema.pre("replaceOne", rejectMutation);

export const Event = models.Event || model<IEvent>("Event", EventSchema);
