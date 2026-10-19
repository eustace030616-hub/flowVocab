/**
 * The local implementation: a SQLite file, the way the app has always run.
 *
 * Still `node:sqlite`, still synchronous underneath. The `async` here is the seam's price, not a
 * claim about how the work happens — on this driver every call resolves immediately.
 */

import { all, db, get, run } from "./db";
import type { StoreDriver } from "./driver";

export const nodeDriver: StoreDriver = {
  async all<T>(sql: string, ...params: unknown[]) {
    return all<T>(sql, ...params);
  },
  async get<T>(sql: string, ...params: unknown[]) {
    return get<T>(sql, ...params) ?? null;
  },
  async run(sql: string, ...params: unknown[]) {
    return run(sql, ...params);
  },
  async transaction<T>(fn: () => Promise<T>) {
    // db.ts's transaction takes a synchronous callback, and a D1-shaped one is async. The statements
    // still run on this same connection, so the boundary is opened by hand around the await rather
    // than reusing that helper — otherwise the whole callback would be one opaque sync unit.
    const handle = db();
    handle.exec("BEGIN");
    try {
      const result = await fn();
      handle.exec("COMMIT");
      return result;
    } catch (error) {
      handle.exec("ROLLBACK");
      throw error;
    }
  },
};
