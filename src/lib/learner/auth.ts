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
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { get, nowMs, run, transaction } from "../store/db";
import { ensureUser } from "../store/learner";

export const SESSION_COOKIE = "flowwing_session";
const SESSION_DAYS = 30;
const KEY_LENGTH = 32;

interface UserRow {
  userId: string;
  username: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  track: string;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, KEY_LENGTH).toString("hex");
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
export function register(
  username: string,
  password: string,
  legacyUserId?: string,
): AuthResult {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };
  if (get("SELECT 1 AS x FROM users WHERE username = ?", name)) return { ok: false, error: "taken" };

  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);

  const userId = randomUUID();
  transaction(() => {
    const legacy = legacyUserId ? get<UserRow>("SELECT * FROM users WHERE userId = ?", legacyUserId) : null;
    if (legacy && !legacy.username) {
      run("UPDATE users SET username = ?, passwordHash = ?, passwordSalt = ?, updatedAt = ? WHERE userId = ?",
        name, hash, salt, nowMs(), legacy.userId);
      return;
    }
    ensureUser(userId);
    run("UPDATE users SET username = ?, passwordHash = ?, passwordSalt = ?, updatedAt = ? WHERE userId = ?",
      name, hash, salt, nowMs(), userId);
  });

  const claimed = legacyUserId && get<UserRow>("SELECT * FROM users WHERE userId = ?", legacyUserId)?.username === name;
  const finalId = claimed ? legacyUserId! : userId;
  const row = get<UserRow>("SELECT * FROM users WHERE userId = ?", finalId)!;
  const token = startSession(finalId);
  return { ok: true, user: { userId: finalId, username: name, track: row.track }, token };
}

export function login(username: string, password: string): AuthResult {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };
  const row = get<UserRow>("SELECT * FROM users WHERE username = ?", name);
  if (!row?.passwordHash || !row.passwordSalt) return { ok: false, error: "bad-credentials" };

  const expected = Buffer.from(row.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, row.passwordSalt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: "bad-credentials" };
  }
  return {
    ok: true,
    user: { userId: row.userId, username: name, track: row.track },
    token: startSession(row.userId),
  };
}
