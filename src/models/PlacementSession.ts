import { Schema, Document, models, model } from "mongoose";
import type { CefrLevel, TargetLang } from "../lib/lang";

/**
 * One sitting of the placement test.
 *
 * The items are stored when the test is served and the responses when it is submitted, because the
 * client must not be told which items are pseudowords — a test whose fakes are visible in the
 * payload measures nothing. Keeping the item set server-side is also what makes the score
 * reproducible: the same session can be re-scored after a change to the estimator.
 */
export interface IPlacementSession extends Document {
  userId: string;
  targetLang: TargetLang;
  seed: number;
  items: Array<{
    id: string;
    text: string;
    isPseudoword: boolean;
    difficulty?: number;
    lemmaKey?: string;
  }>;
  createdAt: Date;
  /**
   * The learner's answers, stored so the session can be re-scored without another client round trip.
   *
   * Without these the item difficulties would be recorded but the answers lost, and the estimate
   * would silently fold in a test the learner never took.
   */
  responses: Array<{ id: string; yes: boolean }>;
  /** Set once submitted; an open session has no result. */
  completedAt?: Date | null;
  score?: {
    hits: number;
    falseAlarms: number;
    falseAlarmRate: number;
    corrected: number;
    dPrime: number;
    theta: number;
    se: number;
    level: CefrLevel | null;
    levelLow: CefrLevel;
    levelHigh: CefrLevel;
  } | null;
}

const PlacementItemSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    isPseudoword: { type: Boolean, required: true },
    difficulty: { type: Number },
    lemmaKey: { type: String },
  },
  { _id: false },
);

const PlacementResponseSchema = new Schema(
  {
    id: { type: String, required: true },
    yes: { type: Boolean, required: true },
  },
  { _id: false },
);

const PlacementSessionSchema = new Schema<IPlacementSession>(
  {
    userId: { type: String, required: true },
    targetLang: { type: String, enum: ["en", "de"], required: true },
    seed: { type: Number, required: true },
    items: { type: [PlacementItemSchema], default: [] },
    responses: { type: [PlacementResponseSchema], default: [] },
    completedAt: { type: Date, default: null },
    score: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// The read path: the newest completed session for a learner and language.
PlacementSessionSchema.index({ userId: 1, targetLang: 1, createdAt: -1 });

export const PlacementSession =
  models.PlacementSession ||
  model<IPlacementSession>("PlacementSession", PlacementSessionSchema);
