import { Schema, Document, models, model, type Types } from "mongoose";
import type { TargetLang } from "../lib/lang";

export type WordStatus = "unfamiliar" | "learning" | "known";

/**
 * One learner's state for one vocabulary item.
 *
 * This is deliberately **not** a field on `Word`. The original schema kept `timesMet` and
 * `unfamiliarity` on the word itself, which is fine only while there is exactly one learner —
 * with two, their histories overwrite each other. A vocabulary entry is shared reference data;
 * how well a given learner knows it is per-learner data, and the two must not live in the same
 * document.
 *
 * Everything here is a cache derived from the append-only Event log (src/lib/learner/state.ts).
 * Recompute it at any time; never treat it as the record.
 */
export interface IWordState extends Document {
  /** Opaque id from User.userId — a String, matching it exactly. */
  userId: string;
  targetLang: TargetLang;
  lemmaKey: string;
  /** The shared vocabulary entry this state is about. */
  wordId: Types.ObjectId;

  status: WordStatus;
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const WordStateSchema = new Schema<IWordState>(
  {
    userId: { type: String, required: true },
    targetLang: { type: String, enum: ["en", "de"], required: true },
    lemmaKey: { type: String, required: true },
    wordId: { type: Schema.Types.ObjectId, ref: "Word", required: true },

    status: { type: String, enum: ["unfamiliar", "learning", "known"], default: "unfamiliar" },
    timesMet: { type: Number, default: 0 },
    unfamiliarity: { type: Number, default: 0 },
    lookupCount: { type: Number, default: 0 },
    exposureCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One state row per learner per item, per language.
WordStateSchema.index({ userId: 1, targetLang: 1, lemmaKey: 1 }, { unique: true });
// "what is this learner struggling with" — the serving query.
WordStateSchema.index({ userId: 1, targetLang: 1, status: 1 });

export const WordState = models.WordState || model<IWordState>("WordState", WordStateSchema);
