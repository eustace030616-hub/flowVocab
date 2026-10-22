/**
 * The store driver on D1.
 *
 * Same four primitives as the local file, so the domain code above does not know which it has. Three
 * differences are worth stating, because they are where a local driver would quietly mislead:
 *
 *   transactions   D1 has no interactive transaction. Its atomic unit is `batch`, which needs the
 *                  statements up front rather than a callback that awaits. The callback form below
 *                  runs the work and commits nothing atomically — it exists so the seam typechecks,
 *                  and call sites that need atomicity must be rewritten as batches.
 *   reads          `all()` returns a promise for the full result set; there is no cursor.
 *   ids            supplied by the caller, because there is no autoincrement to read back cheaply.
 */
import type { StoreDriver } from "../../src/lib/store/driver";

export function d1Driver(db: D1Database): StoreDriver {
  return {
    async all<T>(sql: string, ...params: unknown[]) {
      const { results } = await db.prepare(sql).bind(...params).all<T>();
      return (results ?? []) as T[];
    },
    async get<T>(sql: string, ...params: unknown[]) {
      return ((await db.prepare(sql).bind(...params).first<T>()) ?? null) as T | null;
    },
    async run(sql: string, ...params: unknown[]) {
      await db.prepare(sql).bind(...params).run();
    },
    async transaction<T>(fn: () => Promise<T>) {
      // Not atomic on D1 — see the note above. Kept so the seam is total.
      return fn();
    },
  };
}
