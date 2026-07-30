import mongoose, { Schema, Document, models, model } from "mongoose";

export interface IPost extends Document {
  title: string;
  content?: string;
  published: boolean;
  authorId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const PostSchema = new Schema<IPost>({
  title: { type: String, required: true },
  content: { type: String },
  published: { type: Boolean, default: false },
  authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now },
});

export const Post = models.Post || model<IPost>("Post", PostSchema);
