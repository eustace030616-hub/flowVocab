import mongoose, { Schema, Document, models, model } from "mongoose";
import type { TargetLang } from "../lib/lang";

export type MarkStatus = "marked" | "ignored" | "known";

/**
 * A learner's mark on one occurrence of one item in one paragraph.
 *
 * Replaces the old `ParagraphWord`, which was keyed by `(paragraphId, wordIndex)` — the index
 * of the word in a `content.split(" ")` array. That key cannot survive German or Chinese:
 *
 *   • a German compound is one array slot but several learnable items
 *   • a separable verb's particle sits in a different array slot than its verb
 *   • Chinese has no spaces, so there is no array at all
 *
 * So a mark is keyed by the character span the learner actually touched, and it records the
 * tokenizer version that produced those offsets. When tokenisation changes, spans can be
 * recomputed rather than silently mis-attributed.
 */
export interface IMark extends Document {
  userId: mongoose.Types.ObjectId;
  targetLang: TargetLang;
  paragraphId: mongoose.Types.ObjectId;
  wordId: mongoose.Types.ObjectId;

  /** Exactly the text the learner touched. */
  surface: string;
  /** Join key of the resolved lemma — the compound/separable-aware identity. */
  lemmaKey: string;

  charStart: number;
  charEnd: number;
  tokenizerVersion: number;

  status: MarkStatus;
  markedAt: Date;
  updatedAt: Date;
}

const MarkSchema = new Schema<IMark>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetLang: { type: String, enum: ["en", "de"], required: true },
    paragraphId: { type: Schema.Types.ObjectId, ref: "Paragraph", required: true },
    wordId: { type: Schema.Types.ObjectId, ref: "Word", required: true },

    surface: { type: String, required: true },
    lemmaKey: { type: String, required: true },

    charStart: { type: Number, required: true },
    charEnd: { type: Number, required: true },
    tokenizerVersion: { type: Number, required: true },

    status: { type: String, enum: ["marked", "ignored", "known"], default: "marked" },
    markedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One mark per learner per occurrence. Occurrence identity is the span, not an array slot.
MarkSchema.index(
  { userId: 1, paragraphId: 1, charStart: 1, charEnd: 1 },
  { unique: true },
);
MarkSchema.index({ userId: 1, targetLang: 1, status: 1 });
MarkSchema.index({ paragraphId: 1, charStart: 1 });

export const Mark = models.Mark || model<IMark>("Mark", MarkSchema);
