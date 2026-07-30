import mongoose, { Schema, Document, models, model } from "mongoose";

export type WordStatus = "unfamiliar" | "learning" | "known";

export interface IWord extends Document {
  word: string;
  definition: string;
  status: WordStatus;
  markedFrom: mongoose.Types.ObjectId[];
  timesMet: number;
  unfamiliarity: number;
  createdAt: Date;
  updatedAt: Date;
}

const WordSchema = new Schema<IWord>(
  {
    word: { type: String, required: true, unique: true },
    definition: { type: String, default: "" },
    status: {
      type: String,
      enum: ["unfamiliar", "learning", "known"],
      default: "unfamiliar",
    },
    markedFrom: [{ type: Schema.Types.ObjectId, ref: "Paragraph" }],
    timesMet: { type: Number, default: 0 },
    unfamiliarity: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Word = models.Word || model<IWord>("Word", WordSchema);
