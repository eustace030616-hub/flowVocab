/**
 * Small pure helpers shared by the store and the domain code.
 *
 * They lived in `db.ts`, which imports `node:sqlite` — so any module that needed `nowMs` inherited the
 * Node driver and could not be bundled for Workers. Nothing here touches a database.
 */
/**
 * Identifiers stay 24-character hex, the shape the documents used.
 *
 * Not vanity: existing rows keep their ids through the migration, and the client, the API paths and
 * the marks all reference paragraphs and words by that string. Renumbering would have made the move
 * a rewrite of everything that points at a row.
 */
export function newId(): string {
  return crypto.randomUUID();
}

export function nowMs(): number {
  return Date.now();
}

/** `IN (?, ?, ?)` for a list, with the params to match. Empty lists are the caller's problem. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

/** Booleans are integers in SQLite; this keeps the conversion in one place. */
export function flag(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}
