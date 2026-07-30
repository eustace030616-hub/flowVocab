import mongoose, { Schema, Document, models, model } from "mongoose";

export interface IUser extends Document {
  name: string;
  email: string;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
});

export const User = models.User || model<IUser>("User", UserSchema);
