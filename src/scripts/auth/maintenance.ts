/**
 * Two account jobs: prune the test accounts, and merge duplicates.
 *
 * `walk` and `parity` register a user on every run and never clean up, so the users table fills with
 * accounts nobody can log into. And because the Pi's users table has no unique index on username, the same
 * person could end up with two rows — one per host they registered on — with their history split between
 * them.
 *
 *   node --import tsx src/scripts/auth/maintenance.ts prune            (dry run)
 *   node --import tsx src/scripts/auth/maintenance.ts prune --apply
 *   node --import tsx src/scripts/auth/maintenance.ts merge <from> <to> --apply
 */
import { all, get, openDatabase, run, transaction } from "../../lib/store/db";

/**
 * What counts as a real account.
 *
 * Names are useless here — the test scripts have produced a hundred different prefixes over the months
 * (`walk-`, `parity-`, `chk`, `u17…`, `p217…`, `c0179…`). Behaviour is the honest test: an account nobody
 * ever read with has no events, no marks and no session, and one used by accident has a handful.
 */
const REAL_EVENTS = 10;
const REAL_MARKS = 3;

function userTables(): string[] {
  const tables = all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return tables
    .map((row) => row.name)
    .filter((name) => all<{ name: string }>(`PRAGMA table_info(${name})`).some((column) => column.name === "userId"));
}

function mergeInto(from: string, to: string): void {
  for (const table of userTables()) {
    // UPDATE OR IGNORE keeps rows whose key would collide with an existing one on the target; the DELETE
    // afterwards clears whatever is left, so nothing is stranded.
    run(`UPDATE OR IGNORE ${table} SET userId = ? WHERE userId = ?`, to, from);
    run(`DELETE FROM ${table} WHERE userId = ?`, from);
  }
  run("DELETE FROM users WHERE userId = ?", from);
}

async function main(): Promise<void> {
  const [command, first, second] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
  openDatabase();

  if (command === "merge") {
    if (!first || !second) throw new Error("merge needs two userIds: <from> <to>");
    const from = get<{ username: string }>("SELECT username FROM users WHERE userId = ?", first);
    const to = get<{ username: string }>("SELECT username FROM users WHERE userId = ?", second);
    if (!from || !to) throw new Error("one of those userIds does not exist");
    console.log(`  merge ${from.username} (${first.slice(0, 8)}…) into ${to.username} (${second.slice(0, 8)}…)`);
    if (!apply) {
      console.log("  dry run — add --apply");
      return;
    }
    transaction(() => mergeInto(first, second));
    console.log("  merged");
    return;
  }

  if (command !== "prune") throw new Error("usage: maintenance.ts prune [--apply] | merge <from> <to> [--apply]");

  const users = all<{ userId: string; username: string; events: number; marks: number; sessions: number }>(
    `SELECT u.userId, u.username,
            (SELECT COUNT(*) FROM events e WHERE e.userId = u.userId) AS events,
            (SELECT COUNT(*) FROM marks m WHERE m.userId = u.userId) AS marks,
            (SELECT COUNT(*) FROM sessions s WHERE s.userId = u.userId) AS sessions
       FROM users u WHERE u.username IS NOT NULL ORDER BY u.createdAt ASC`,
  );
  const real = users.filter((user) => user.events >= REAL_EVENTS || user.marks >= REAL_MARKS);
  const junk = users.filter((user) => !real.includes(user));

  console.log(`  ${users.length} named accounts · ${real.length} with real activity, ${junk.length} without`);
  console.log("  keeping:");
  for (const user of real) console.log(`    ${user.username}  (${user.events} events · ${user.marks} marks · ${user.sessions} sessions)`);
  console.log("  deleting:");
  for (const user of junk.slice(0, 8)) console.log(`    ${user.username}`);
  if (junk.length > 8) console.log(`    … and ${junk.length - 8} more`);

  if (!apply) {
    console.log("  dry run — add --apply to delete them and everything they own");
    return;
  }
  transaction(() => {
    for (const user of junk) {
      for (const table of userTables()) run(`DELETE FROM ${table} WHERE userId = ?`, user.userId);
      run("DELETE FROM users WHERE userId = ?", user.userId);
    }
  });
  const left = all<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE username IS NOT NULL")[0].n;
  console.log(`  deleted ${junk.length} test accounts · ${left} named accounts left`);
}

void main();
