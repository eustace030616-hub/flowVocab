/**
 * Accounts on Workers, over D1.
 *
 * The same behaviour as the Pi's `src/lib/learner/auth.ts` — any name, any password, salted hash, an
 * opaque session token of which only the hash is stored — written against the async driver, because
 * D1 is across a network call. This is the shape the Pi's module will take once the store is async;
 * writing it here first is what proves the Workers half can exist without porting everything.
 */
import type { StoreDriver } from "../../src/lib/store/driver";
import { hashPassword, hashToken, verifyStored } from "./crypto";

export const SESSION_COOKIE = "flowwing_session";
const SESSION_DAYS = 30;

export interface SessionUser {
  userId: string;
  username: string;
  track: string;
}

export type AuthResult =
  | { ok: true; user: SessionUser; token: string }
  | { ok: false; error: "taken" | "bad-credentials" | "missing" };

export async function sessionUser(store: StoreDriver, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await store.get<{ userId: string; expiresAt: number; username: string; track: string }>(
    `SELECT s.userId, s.expiresAt, u.username, u.track
       FROM sessions s JOIN users u ON u.userId = s.userId
      WHERE s.tokenHash = ?`,
    await hashToken(token),
  );
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    await store.run("DELETE FROM sessions WHERE tokenHash = ?", await hashToken(token));
    return null;
  }
  return { userId: row.userId, username: row.username, track: row.track };
}

async function startSession(store: StoreDriver, userId: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await store.run(
    "INSERT INTO sessions (id, userId, tokenHash, createdAt, expiresAt) VALUES (?,?,?,?,?)",
    crypto.randomUUID(),
    userId,
    await hashToken(token),
    Date.now(),
    Date.now() + SESSION_DAYS * 86_400_000,
  );
  return token;
}

export async function register(store: StoreDriver, username: string, password: string): Promise<AuthResult> {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };
  if (await store.get("SELECT 1 AS x FROM users WHERE username = ?", name)) {
    return { ok: false, error: "taken" };
  }

  const userId = crypto.randomUUID();
  // The portable format, one column: the same string the Pi writes, so an account works on both.
  const hash = await hashPassword(password);
  await store.run(
    "INSERT INTO users (id, userId, track, uiLocale, username, passwordHash, passwordSalt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,NULL,?,?)",
    userId, userId, "en-de", "en", name, hash, Date.now(), Date.now(),
  );
  return { ok: true, user: { userId, username: name, track: "en-de" }, token: await startSession(store, userId) };
}

export async function login(store: StoreDriver, username: string, password: string): Promise<AuthResult> {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };
  const row = await store.get<{ userId: string; track: string; passwordHash: string | null; passwordSalt: string | null }>(
    "SELECT userId, track, passwordHash, passwordSalt FROM users WHERE username = ?",
    name,
  );
  if (!row?.passwordHash || !row.passwordSalt) return { ok: false, error: "bad-credentials" };
  if (!(await verifyStored(password, row.passwordHash))) {
    return { ok: false, error: "bad-credentials" };
  }
  return { ok: true, user: { userId: row.userId, username: name, track: row.track }, token: await startSession(store, row.userId) };
}

export async function endSession(store: StoreDriver, token: string | undefined): Promise<void> {
  if (!token) return;
  await store.run("DELETE FROM sessions WHERE tokenHash = ?", await hashToken(token));
}
