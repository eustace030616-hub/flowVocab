/**
 * Import accounts exported from the Worker's D1 into this host's database.
 *
 * The Worker is being dismantled and the Pi is taking over identity, so users have to move before the
 * database that holds them is deleted. `id` and `userId` carry the same value here (see `register`), and
 * the hash crosses untouched: `password.ts` verifies both the portable format and the legacy scrypt rows,
 * with no re-hash and no password reset.
 *
 *   node --import tsx src/scripts/auth/import-users.ts /tmp/d1-users.json
 */
import { readFile } from "node:fs/promises";
import { all, openDatabase, run } from "../../lib/store/db";

interface ExportedUser {
  userId: string;
  username: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  track?: string | null;
  uiLocale?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: import-users.ts <export.json>");
    process.exitCode = 1;
    return;
  }
  openDatabase();

  const raw = JSON.parse(await readFile(path, "utf8")) as
    | ExportedUser[]
    | Array<{ results: ExportedUser[] }>;
  const users = Array.isArray(raw) && raw[0] && "results" in raw[0] ? raw[0].results : (raw as ExportedUser[]);

  const existing = new Set(
    all<{ username: string }>("SELECT username FROM users WHERE username IS NOT NULL").map((row) => row.username),
  );

  let added = 0;
  let updated = 0;
  for (const user of users) {
    if (!user.username || !user.userId) continue;
    const row = {
      id: user.userId,
      userId: user.userId,
      username: user.username,
      track: user.track ?? "en-de",
      uiLocale: user.uiLocale ?? "en",
      passwordHash: user.passwordHash ?? null,
      passwordSalt: user.passwordSalt ?? null,
      createdAt: user.createdAt ?? Date.now(),
      updatedAt: user.updatedAt ?? Date.now(),
    };
    if (existing.has(user.username)) {
      run(
        `UPDATE users SET passwordHash = ?, passwordSalt = ?, track = ?, uiLocale = ?, updatedAt = ?
          WHERE username = ?`,
        row.passwordHash,
        row.passwordSalt,
        row.track,
        row.uiLocale,
        row.updatedAt,
        row.username,
      );
      updated += 1;
      continue;
    }
    run(
      `INSERT OR REPLACE INTO users (id, userId, track, uiLocale, createdAt, updatedAt, username, passwordHash, passwordSalt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.userId,
      row.track,
      row.uiLocale,
      row.createdAt,
      row.updatedAt,
      row.username,
      row.passwordHash,
      row.passwordSalt,
    );
    added += 1;
  }

  const total = all<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE username IS NOT NULL")[0].n;
  console.log(`  imported ${users.length}: ${added} added, ${updated} updated · ${total} named accounts now`);
}

void main();
