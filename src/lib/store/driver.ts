/**
 * The seam between the domain store and whatever is holding the rows.
 *
 * Four primitives, async, so that one implementation can be a local SQLite file and another can be a
 * database on the other side of a network call. Everything above this line is domain logic and does
 * not know which it is talking to.
 *
 * This file exists because of a hosting decision, so it is worth being clear about what the decision
 * costs. On Node the underlying calls are synchronous and these wrappers simply return what they
 * already had — no performance change. On Workers there is no local file, and every call is a real
 * round trip, which is why the *callers* have to be async too: a pipeline of six queries that was
 * free now costs six hops.
 */
export interface StoreDriver {
  /** Every row. */
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** The first row, or `null`. */
  get<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  /** Execute, ignoring any result. */
  run(sql: string, ...params: unknown[]): Promise<void>;
  /** Run `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
