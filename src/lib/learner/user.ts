/**
 * Learner identity.
 *
 * Phase 0 does not build authentication. A learner is identified by an opaque id in a
 * cookie, created on first request. That is enough to make every learner-model read and
 * write per-user, which is the actual requirement — the original app had one shared global
 * word counter for the whole database.
 *
 * Replacing this with real auth means changing `resolveUser` and nothing else: no model,
 * no route, and no derivation code depends on how the id was obtained.
 */

import { randomUUID } from "node:crypto";
import { User, trackFor } from "../../models/User";
import type { TrackId } from "../lang";

export const USER_COOKIE = "fv_uid";

export interface ResolvedUser {
  userId: string;
  track: TrackId;
}

/** Find the learner for this cookie value, or mint a new one. */
export async function resolveUser(cookieUserId?: string): Promise<{
  user: ResolvedUser;
  created: boolean;
}> {
  if (cookieUserId) {
    const existing = await User.findOne({ userId: cookieUserId }).lean();
    if (existing) {
      return { user: { userId: existing.userId, track: existing.track }, created: false };
    }
  }

  const userId = randomUUID();
  const doc = await User.create({ userId });
  return { user: { userId: doc.userId, track: doc.track }, created: true };
}

export async function setTrack(userId: string, track: TrackId): Promise<ResolvedUser> {
  const doc = await User.findOneAndUpdate({ userId }, { track }, { returnDocument: "after" }).lean();
  if (!doc) throw new Error(`unknown user ${userId}`);
  return { userId: doc.userId, track: doc.track };
}

/** The full (targetLang, glossLang, uiLocale) triple for a user. */
export function trackOf(user: ResolvedUser) {
  return trackFor(user);
}
