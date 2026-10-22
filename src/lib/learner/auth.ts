/**
 * Accounts: one module for both runtimes.
 *
 * There used to be two of these — a synchronous one for the Pi and an async copy for Workers —
 * which is exactly the sort of duplication that drifts: the copy on Workers promptly disagreed with
 * the original about how a password is stored. The logic is now here once, and the only thing that
 * varies is the driver it is handed (a local SQLite file on the Pi, D1 on Workers).
 *
 * Dev stage: any name, any password, no email, no confirmation, no reset. Two things are still done
 * properly, because skipping them is a habit: passwords are salted and hashed in the portable format
 * (see `password-core.ts`), and only a hash of the session token is stored.
 */
import { hashPassword, hashToken, verifyPasswordCore } from "./password-core";

/**
 * Verify against this host's own row, including formats the other runtime cannot handle.
 *
 * `node:crypto` is imported lazily because this module is bundled for Workers too, where it does not
 * exist — that path never runs there, because the authority never heals itself.
 */
async function verifyLocal(
  password: string,
  stored: string,
  salt: string | null,
): Promise<{ ok: boolean; upgrade?: string }> {
  if (stored.startsWith("pbkdf2$")) return verifyPasswordCore(password, stored);
  const { scryptSync, timingSafeEqual } = await import("node:crypto");
  if (!salt) return { ok: false };
  const expected = Buffer.from(stored, "hex");
  const actual = scryptSync(password, salt, expected.length);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false };
  return { ok: true, upgrade: await hashPassword(password) };
}
import type { StoreDriver } from "../store/driver";

export const SESSION_COOKIE = "flowwing_session";
const SESSION_DAYS = 30;

interface UserRow {
  userId: string;
  username: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  track: string;
}

/**
 * The identity service, when this host is not the authority.
 *
 * The Pi holds the passages and the generation, but not the accounts: Cloudflare's D1 does. So the Pi
 * asks it here and mirrors the answer into its own `users` table with the *same* `userId`, which keeps
 * marks attached to a globally single identity while both databases stay independent.
 *
 * With no service configured (the Worker itself), everything stays local.
 */
interface ServiceConfig {
  url: string;
  secret: string;
}

function service(): ServiceConfig | null {
  // `process` does not exist on Workers, and this module runs there — the authority does not call
  // itself, so it simply has no service configured.
  const env: Record<string, string | undefined> =
    typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};
  const url = env.FLOWWING_IDENTITY_URL;
  const secret = env.FLOWWING_IDENTITY_SECRET;
  return url && secret ? { url: url.replace(/\/$/, ""), secret } : null;
}

async function askIdentity(
  path: "register" | "login",
  body: { username: string; password: string },
): Promise<{ ok: true; user: SessionUser } | { ok: false; status: number }> {
  const config = service()!;
  try {
    const response = await fetch(`${config.url}/api/service/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Flowwing-Service": config.secret },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const data = (await response.json()) as SessionUser;
    return { ok: true, user: data };
  } catch {
    // Unreachable authority is not "wrong password": say so, rather than minting a shadow account.
    return { ok: false, status: 0 };
  }
}

/** Keep a local row with the shared identity, so marks and states have a user to hang from. */
async function mirrorUser(store: StoreDriver, user: SessionUser): Promise<void> {
  const existing = await store.get("SELECT 1 AS x FROM users WHERE userId = ?", user.userId);
  if (existing) {
    await store.run("UPDATE users SET username = ?, updatedAt = ? WHERE userId = ?", user.username, Date.now(), user.userId);
    return;
  }
  await store.run(
    "INSERT INTO users (id, userId, track, uiLocale, username, passwordHash, passwordSalt, createdAt, updatedAt) VALUES (?,?,?,?,?,NULL,NULL,?,?)",
    user.userId, user.userId, user.track, "en", user.username, Date.now(), Date.now(),
  );
}

/**
 * Verify locally against this host's own row and, if that produced an upgraded hash, send it to the
 * authority. Returns the identity when the password was right.
 */
async function healAuthority(
  username: string,
  password: string,
  store: StoreDriver,
): Promise<{ user: SessionUser } | null> {
  const row = await store.get<{ userId: string; username: string; track: string; passwordHash: string | null; passwordSalt: string | null }>(
    "SELECT userId, username, track, passwordHash, passwordSalt FROM users WHERE username = ?",
    username,
  );
  if (!row?.passwordHash) return null;
  const verified = await verifyLocal(password, row.passwordHash, row.passwordSalt);
  if (!verified.ok) return null;

  const config = service()!;
  // Push whatever the authority can use: the upgraded hash when there is one, otherwise this host's
  // own — the password has just been verified, so either is a value the authority may store.
  const portable = verified.upgrade ?? row.passwordHash;
  if (portable.startsWith("pbkdf2$")) {
    try {
      await fetch(`${config.url}/api/service/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Flowwing-Service": config.secret },
        body: JSON.stringify({ username: row.username, passwordHash: portable }),
      });
    } catch {
      // The upgrade is kept locally either way; the next sign-in tries again.
    }
  }
  return { user: { userId: row.userId, username: row.username, track: row.track } };
}

export interface SessionUser {
  userId: string;
  username: string;
  track: string;
}

export type AuthResult =
  | { ok: true; user: SessionUser; token: string }
  | { ok: false; error: "taken" | "bad-credentials" | "missing" };

/** A session token: 32 random bytes, url-safe, generated by the runtime's own crypto. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Who this session belongs to, or `null` if the cookie is absent, unknown or expired. */
export async function sessionUser(
  token: string | undefined,
  store: StoreDriver,
): Promise<SessionUser | null> {
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
  const token = newToken();
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

export async function endSession(token: string | undefined, store: StoreDriver): Promise<void> {
  if (!token) return;
  await store.run("DELETE FROM sessions WHERE tokenHash = ?", await hashToken(token));
}

/**
 * Create an account, or attach one to a user that predates accounts.
 *
 * `legacyUserId` is the cookie identity the app used before there were logins. Registering from a
 * browser that already has one claims that history instead of creating a second, empty user.
 */
export async function register(
  username: string,
  password: string,
  legacyUserId: string | undefined,
  store: StoreDriver,
): Promise<AuthResult> {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };

  if (service()) {
    const answer = await askIdentity("register", { username: name, password });
    if (!answer.ok) return { ok: false, error: answer.status === 409 ? "taken" : "missing" };
    await mirrorUser(store, answer.user);
    return { ok: true, user: answer.user, token: await startSession(store, answer.user.userId) };
  }
  if (await store.get("SELECT 1 AS x FROM users WHERE username = ?", name)) {
    return { ok: false, error: "taken" };
  }

  const hash = await hashPassword(password);
  const legacy = legacyUserId ? await store.get<UserRow>("SELECT * FROM users WHERE userId = ?", legacyUserId) : null;

  if (legacy && !legacy.username) {
    await store.run(
      "UPDATE users SET username = ?, passwordHash = ?, passwordSalt = NULL, updatedAt = ? WHERE userId = ?",
      name, hash, Date.now(), legacy.userId,
    );
    return {
      ok: true,
      user: { userId: legacy.userId, username: name, track: legacy.track },
      token: await startSession(store, legacy.userId),
    };
  }

  const userId = crypto.randomUUID();
  await store.run(
    "INSERT INTO users (id, userId, track, uiLocale, username, passwordHash, passwordSalt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,NULL,?,?)",
    userId, userId, "en-de", "en", name, hash, Date.now(), Date.now(),
  );
  return { ok: true, user: { userId, username: name, track: "en-de" }, token: await startSession(store, userId) };
}

export interface LoginOptions {
  store: StoreDriver;
  /**
   * Verifier for legacy rows, for hosts that can do it.
   *
   * scrypt exists on Node and not on Workers, so the portable format is the default and the Pi passes
   * its own verifier to keep old accounts working (and to upgrade them). A Workers host simply
   * rejects a legacy row, which is why a legacy account's first sign-in happens on the Pi.
   */
  verifyLegacy?: (password: string, stored: string, salt: string | null) => Promise<{ ok: boolean; upgrade?: string }>;
}

export async function login(
  username: string,
  password: string,
  options: LoginOptions,
): Promise<AuthResult> {
  if (!options.store) throw new Error("login needs a store: the driver is the only thing that differs between hosts");
  const store = options.store;
  const name = username.trim();
  if (!name || !password) return { ok: false, error: "missing" };

  if (service()) {
    const answer = await askIdentity("login", { username: name, password });
    if (answer.ok) {
      await mirrorUser(store, answer.user);
      return { ok: true, user: answer.user, token: await startSession(store, answer.user.userId) };
    }
    // The authority could not verify it. Node can: a hash above the Workers PBKDF2 ceiling (or a
    // legacy scrypt row) verifies here and is upgraded, then pushed back so the account works on both
    // hosts from now on.
    const healed = await healAuthority(name, password, store);
    if (!healed) return { ok: false, error: "bad-credentials" };
    await mirrorUser(store, healed.user);
    return { ok: true, user: healed.user, token: await startSession(store, healed.user.userId) };
  }
  const row = await store.get<UserRow>("SELECT * FROM users WHERE username = ?", name);
  if (!row?.passwordHash) return { ok: false, error: "bad-credentials" };

  const verified = row.passwordHash.startsWith("pbkdf2$")
    ? await verifyPasswordCore(password, row.passwordHash)
    : ((await options.verifyLegacy?.(password, row.passwordHash, row.passwordSalt)) ?? { ok: false });
  if (!verified.ok) return { ok: false, error: "bad-credentials" };
  // A legacy scrypt row migrates itself here, so the account works on Workers from now on.
  if (verified.upgrade) {
    await store.run(
      "UPDATE users SET passwordHash = ?, passwordSalt = NULL, updatedAt = ? WHERE userId = ?",
      verified.upgrade, Date.now(), row.userId,
    );
  }
  return {
    ok: true,
    user: { userId: row.userId, username: name, track: row.track },
    token: await startSession(store, row.userId),
  };
}
