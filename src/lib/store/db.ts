/**
 * The SQLite connection and the small amount of glue every query needs.
 *
 * `node:sqlite` is built into Node 24, so this is the whole data-layer dependency: no native build,
 * no server, no Docker. The database is one file next to the code.
 *
 * Rows are converted to the *domain* shape here — camelCase, parsed JSON, real booleans — so the rest
 * of the app never sees a database row. That is what makes the store swappable: the SQLite and Mongo
 * shapes differ, the domain shape does not.
 */

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { SCHEMA_SQL } from "./schema";

/** Where the database lives. Gitignored, like the source data it is built from. */
export const DATABASE_PATH =
  process.env.FLOWWING_DB ?? path.join(process.cwd(), "data", "flowwing.sqlite3");





/**
 * Columns added after a table already existed.
 *
 * `CREATE TABLE IF NOT EXISTS` creates a table and does nothing to one that is already there, so a
 * new column silently fails to appear on a database that has data in it — which is every database
 * this app has. SQLite cannot add a column conditionally, so the check is explicit.
 *
 * Kept as a list rather than a migration framework: there is one table per concept and one file, and
 * a framework would be more machinery than the problem has. When this grows past a handful of rows,
 * it wants a real migration tool.
 */
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "paragraphs", column: "starred", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "difficulty_votes", column: "explicit", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "users", column: "username", ddl: "TEXT" },
  { table: "users", column: "passwordHash", ddl: "TEXT" },
  { table: "users", column: "passwordSalt", ddl: "TEXT" },
];

function applyColumnMigrations(handle: DatabaseSync): void {
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = handle.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === migration.column)) continue;
    handle.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.ddl}`);
  }
}

let database: DatabaseSync | null = null;

/** Open the database, applying the schema. Idempotent, so every caller can just ask for it. */
/**
 * Columns added after a database was created.
 *
 * `CREATE TABLE IF NOT EXISTS` does not touch an existing table, so a column added later has to be
 * added explicitly. SQLite has no `ADD COLUMN IF NOT EXISTS`, and the error for a duplicate is the
 * cheapest possible probe.
 */
function migrate(db: DatabaseSync): void {
  for (const statement of [
    "ALTER TABLE sessions ADD COLUMN lastSeenAt INTEGER",
  ]) {
    try {
      db.exec(statement);
    } catch {
      /* already there */
    }
  }
}

/**
 * The word book gained a language dimension, and a primary key cannot be widened in place.
 *
 * Its rows are derived data loaded by a seeder, so the honest migration is to remove the old table and let
 * the schema build the new one. This runs *before* `SCHEMA_SQL`: dropping afterwards would delete the table
 * the schema had just created.
 */
function dropPreLanguageWordbook(db: DatabaseSync): void {
  try {
    const columns = db.prepare("PRAGMA table_info(wordbook)").all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some((column) => column.name === "targetLang")) {
      db.exec("DROP TABLE wordbook");
    }
  } catch {
    /* no table, or no PRAGMA support: nothing to migrate */
  }
}

export function openDatabase(file: string = DATABASE_PATH): DatabaseSync {
  if (database) return database;

  const directory = path.dirname(file);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  database = new DatabaseSync(file);
  dropPreLanguageWordbook(database);
  database.exec(SCHEMA_SQL);
  applyColumnMigrations(database);
  migrate(database);
  return database;
}

/** The open handle. Opens on first use, so callers never have to sequence it. */
export function db(): DatabaseSync {
  return openDatabase();
}

/** For tests and scripts that need a fresh file. */
export function closeDatabase(): void {
  database?.close();
  database = null;
}

export type Row = Record<string, unknown>;

// Pure helpers live in `util.ts`; re-exported so callers do not care where they are defined.
export { bool, flag, json, newId, nowMs, placeholders } from "./util";

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): void {
  db().prepare(sql).run(...(params as never[]));
}









/**
 * Run a batch inside one transaction.
 *
 * The importers write hundreds of thousands of rows; without this each statement is its own commit,
 * which is the difference between seconds and minutes.
 */
export function transaction<T>(work: () => T): T {
  const handle = db();
  handle.exec("BEGIN");
  try {
    const result = work();
    handle.exec("COMMIT");
    return result;
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}
