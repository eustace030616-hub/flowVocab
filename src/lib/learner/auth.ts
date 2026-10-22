/**
 * Dev-stage accounts: a username, a password, a session cookie.
 *
 * Deliberately without rules — any string is a username, any string is a password, no email, no
 * confirmation, no reset. The point of this stage is to tell users apart, not to defend an account
 * worth stealing.
 *
 * Two things are still done properly, because they are cheap and because skipping them would be a
 * habit:
 *
 *   passwords   scrypt with a per-user salt. A dev database is still a database.
 *   sessions    an opaque token in the cookie; only its SHA-256 is stored, so the table cannot be
 *               replayed if it leaks.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { hashPassword, verifyPassword } from "./password";
import { get, nowMs, run, transaction } from "../store/db";
import { ensureUser } from "../store/learner";

export const SESSION_COOKIE = "flowwing_session";
const SESSION_DAYS = 30;

interface UserRow {
  userId: string;
  username: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  track: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  userId: string;
  username: string;
  track: string;
}

/** Who this session belongs to, or `null` if the cookie is absent, unknown or expired. */
export function sessionUser(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = get<{ userId: string; expiresAt: number; username: string; track: string }>(
    `SELECT s.userId, s.expiresAt, u.username, u.track
       FROM sessions s JOIN users u ON u.userId = s.userId
      WHERE s.tokenHash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  if (row.expiresAt < nowMs()) {
    run("DELETE FROM sessions WHERE tokenHash = ?", hashToken(token));
    return null;
  }
  return { userId: row.userId, username: row.username, track: row.track };
}

/** A new session for a user; returns the cookie value. */
export function startSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  run(
    "INSERT INTO sessions (id, userId, tokenHash, createdAt, expiresAt) VALUES (?,?,?,?,?)",
    randomUUID(),
    userId,
    hashToken(token),
    nowMs(),
    nowMs() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  );
  return token;
}

export function endSession(token: string | undefined): void {
  if (!token) return;
  run("DELETE FROM sessions WHERE tokenHash = ?", hashToken(token));
}

export type AuthResult =
  | { ok: true; user: SessionUser; token: string }
  | { ok: false; error: "taken" | "bad-credentials" | "missing" };

/**
 * Create an account, or attach one to a user that predates accounts.
 *
 * `legacyUserId` is the cookie identity the app used before there were logins. Registering from a
 * browser that already has one claims that history instead of creating a second, empty user: the
 * alternative is that the first person to register silently loses every passage they marked.
 */
export async function register(
  username: string,
  password: string,
  legacyUserId?: string,
): Promise<AuthResult> {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };
  if (get("SELECT 1 AS x FROM users WHERE username = ?", name)) return { ok: false, error: "taken" };

  const hash = await hashPassword(password);

  const userId = randomUUID();
  transaction(() => {
    const legacy = legacyUserId ? get<UserRow>("SELECT * FROM users WHERE userId = ?", legacyUserId) : null;
    if (legacy && !legacy.username) {
      run("UPDATE users SET username = ?, passwordHash = ?, passwordSalt = NULL, updatedAt = ? WHERE userId = ?",
        name, hash, nowMs(), legacy.userId);
      return;
    }
    ensureUser(userId);
    run("UPDATE users SET username = ?, passwordHash = ?, passwordSalt = NULL, updatedAt = ? WHERE userId = ?",
      name, hash, nowMs(), userId);
  });

  const claimed = legacyUserId && get<UserRow>("SELECT * FROM users WHERE userId = ?", legacyUserId)?.username === name;
  const finalId = claimed ? legacyUserId! : userId;
  const row = get<UserRow>("SELECT * FROM users WHERE userId = ?", finalId)!;
  const token = startSession(finalId);
  return { ok: true, user: { userId: finalId, username: name, track: row.track }, token };
}

export async function login(username: string, password: string): Promise<AuthResult> {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };
  const row = get<UserRow>("SELECT * FROM users WHERE username = ?", name);
  // `passwordSalt` is only meaningful for a legacy scrypt row; the portable format carries its salt
  // inside `passwordHash`, so requiring the column here rejected every upgraded account.
  if (!row?.passwordHash) return { ok: false, error: "bad-credentials" };

  const verified = await verifyPassword(password, row.passwordHash, row.passwordSalt);
  if (!verified.ok) return { ok: false, error: "bad-credentials" };
  // A legacy scrypt row migrates itself here, so the account works on Workers from now on.
  if (verified.upgrade) {
    run("UPDATE users SET passwordHash = ?, passwordSalt = NULL, updatedAt = ? WHERE userId = ?",
      verified.upgrade, nowMs(), row.userId);
  }
  return {
    ok: true,
    user: { userId: row.userId, username: name, track: row.track },
    token: startSession(row.userId),
  };
}
