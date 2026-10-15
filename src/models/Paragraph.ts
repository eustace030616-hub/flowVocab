import mongoose, { Schema, Document, models, model } from "mongoose";
import type { CefrLevel, TargetLang } from "../lib/lang";

export type ParagraphTopic =
  | "education"
  | "tech"
  | "environment"
  | "work_business"
  | "society_health";

export type ParagraphSource = "seed" | "agent" | "import";

export interface IParagraph extends Document {
  targetLang: TargetLang;
  title: string;
  content: string;
  topic: ParagraphTopic;
  wordCount: number;

  /** CEFR label for the text as a whole, when known. */
  level: CefrLevel | null;
  /** Continuous text difficulty in [0,1]; -1 when unknown. */
  difficulty: number;
  /** How the difficulty was obtained, so the app can say "estimated" rather than imply a measurement. */
  difficultySource: string | null;
  /**
   * Lexical coverage for the *serving* learner at generation time. Not a property of the text
   * alone — it is recomputed per learner, and stored here only as the last known value.
   */
  coverage: number;
  /** Tokenizer version used when this text was last indexed/marked. */
  tokenizerVersion: number;

  source: ParagraphSource;
  /** Prompt snapshot for generated text, as specified in FLOWWING.md. */
  promptSnapshot?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ParagraphSchema = new Schema<IParagraph>(
  {
    targetLang: { type: String, enum: ["en", "de"], required: true, default: "en" },
    title: { type: String, required: true },
    content: { type: String, required: true },
    topic: {
      type: String,
      enum: ["education", "tech", "environment", "work_business", "society_health"],
      required: true,
    },
    wordCount: { type: Number, required: true },

    level: { type: String, enum: ["A1", "A2", "B1", "B2", "C1", "C2", null], default: null },
    difficulty: { type: Number, default: -1 },
    difficultySource: { type: String, default: null },
    coverage: { type: Number, default: -1 },
    tokenizerVersion: { type: Number, default: 1 },

    source: { type: String, enum: ["seed", "agent", "import"], default: "seed" },
    promptSnapshot: { type: String },
  },
  { timestamps: true },
);

ParagraphSchema.index({ targetLang: 1, difficulty: 1 });
ParagraphSchema.index({ targetLang: 1, topic: 1 });

export const Paragraph = models.Paragraph || model<IParagraph>("Paragraph", ParagraphSchema);
