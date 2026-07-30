import mongoose, { Schema, Document, models, model } from "mongoose";

export type ParagraphWordStatus = "marked" | "ignored" | "known";

export interface IParagraphWord extends Document {
  paragraphId: mongoose.Types.ObjectId;
  wordId: mongoose.Types.ObjectId;
  wordIndex: number;
  status: ParagraphWordStatus;
  markedAt: Date;
  updatedAt: Date;
}

const ParagraphWordSchema = new Schema<IParagraphWord>(
  {
    paragraphId: { type: Schema.Types.ObjectId, ref: "Paragraph", required: true },
    wordId: { type: Schema.Types.ObjectId, ref: "Word", required: true },
    wordIndex: { type: Number, required: true },
    status: {
      type: String,
      enum: ["marked", "ignored", "known"],
      default: "marked",
    },
    markedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Each word occurrence in a paragraph is unique
ParagraphWordSchema.index({ paragraphId: 1, wordIndex: 1 }, { unique: true });

export const ParagraphWord =
  models.ParagraphWord || model<IParagraphWord>("ParagraphWord", ParagraphWordSchema);
