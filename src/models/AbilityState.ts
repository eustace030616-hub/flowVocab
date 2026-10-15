import { Schema, Document, models, model } from "mongoose";
import type { CefrLevel, TargetLang } from "../lib/lang";

/**
 * Cached ability estimate, one row per (learner, target language).
 *
 * A cache, in the same sense as `WordState`: the Event log is the truth and this is a fold over it,
 * so it can be recomputed at any time and a bad row is repairable rather than permanent.
 *
 * One row per language, never one global number. A B2 English level is not a B2 German level, and
 * the design being replaced kept a single `levelScore` with no language dimension at all — adding
 * German to it would have silently shared one level between two languages.
 */
export interface IAbilityState extends Document {
  userId: string;
  targetLang: TargetLang;
  /** Ability on the item-difficulty axis, [0, 1]. */
  theta: number;
  /** Standard error of theta, same units. */
  se: number;
  /** Effective observations behind the estimate. */
  n: number;
  /** A single level, only when the interval is narrow enough to claim one. */
  level: CefrLevel | null;
  /** The interval, always reportable. */
  levelLow: CefrLevel;
  levelHigh: CefrLevel;
  /**
   * The centre another language lent this estimate, or null when it stands on its own evidence.
   *
   * Persisted rather than inferred: "no evidence" and "another language's number wearing this
   * language's name" are different states, and only the second may be labelled as transfer.
   */
  priorTheta: number | null;
  updatedAt: Date;
}

const AbilityStateSchema = new Schema<IAbilityState>(
  {
    userId: { type: String, required: true },
    targetLang: { type: String, enum: ["en", "de"], required: true },
    theta: { type: Number, required: true },
    se: { type: Number, required: true },
    n: { type: Number, default: 0 },
    level: { type: String, enum: ["A1", "A2", "B1", "B2", "C1", "C2"], default: null },
    levelLow: { type: String, required: true },
    levelHigh: { type: String, required: true },
    priorTheta: { type: Number, default: null },
  },
  { timestamps: true },
);

AbilityStateSchema.index({ userId: 1, targetLang: 1 }, { unique: true });

export const AbilityState =
  models.AbilityState || model<IAbilityState>("AbilityState", AbilityStateSchema);
