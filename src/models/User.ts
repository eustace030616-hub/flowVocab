import mongoose, { Schema, Document, models, model } from "mongoose";
import { DEFAULT_TRACK, isTrackId, type Track, type TrackId, TRACKS } from "../lib/lang";

/**
 * A learner.
 *
 * The original app had a `User` model that was never used, and every `Word` counter was
 * therefore global — one shared "brain" for the whole database. Since the learner model now
 * has to hold two per-language ability estimates, learner identity has to be real.
 *
 * Phase 0 deliberately does NOT build authentication. Identity is a server-issued cookie
 * holding an opaque id; swapping in real auth later means replacing `resolveUser` only, and
 * nothing else in the learner model has to change.
 */
export interface IUser extends Document {
  /** Opaque, server-issued. Not a credential — possession is the whole of the auth story. */
  userId: string;
  track: TrackId;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    userId: { type: String, required: true, unique: true },
    track: {
      type: String,
      enum: ["zh-en", "en-de"],
      default: DEFAULT_TRACK,
      validate: {
        validator: (v: unknown) => isTrackId(v),
        message: (props: { value: unknown }) => `${String(props.value)} is not a known track`,
      },
    },
  },
  { timestamps: true },
);

export const User = models.User || model<IUser>("User", UserSchema);

/** The full (targetLang, glossLang, uiLocale) triple for a user's current track. */
export function trackFor(user: Pick<IUser, "track">): Track {
  return TRACKS[user.track] ?? TRACKS[DEFAULT_TRACK];
}
