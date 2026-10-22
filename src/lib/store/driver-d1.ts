/**
 * The D1 driver, shared by the Worker entry and anything else that has a D1 binding.
 *
 * Typed structurally rather than against `@cloudflare/workers-types`, so the Node build does not need
 * Cloudflare's global types to compile a file it never runs.
 */
import type { StoreDriver } from "./driver";

export interface D1LikeResult<T> {
  results?: T[];
}
export interface D1LikeStatement {
  bind(...params: unknown[]): D1LikeStatement;
  all<T>(): Promise<D1LikeResult<T>>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1LikeStatement;
}

export function d1Bridge(db: D1Like): StoreDriver {
  return {
    kind: "d1",
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
      // D1 has no interactive transaction: its atomic unit is a batch, which needs the statements up
      // front. Kept so the seam is total; call sites that need atomicity must become batches.
      return fn();
    },
  };
}
