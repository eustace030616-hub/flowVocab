import mongoose, { Schema, Document, models, model } from "mongoose";

export type ParagraphTopic = "education" | "tech" | "environment" | "work_business" | "society_health";

export interface IParagraph extends Document {
  title: string;
  content: string;
  topic: ParagraphTopic;
  wordCount: number;
  createdAt: Date;
}

const ParagraphSchema = new Schema<IParagraph>({
  title: { type: String, required: true },
  content: { type: String, required: true },
  topic: {
    type: String,
    enum: ["education", "tech", "environment", "work_business", "society_health"],
    required: true,
  },
  wordCount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const Paragraph = models.Paragraph || model<IParagraph>("Paragraph", ParagraphSchema);
