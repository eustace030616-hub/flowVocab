/**
 * Types for `node:sqlite`, which Node 24 ships built in.
 *
 * Declared here because `@types/node` at this version predates the module, and the alternative was
 * upgrading the type package across the whole project for one import. This covers exactly what the
 * store uses — synchronous statements with positional parameters — and nothing more; if the store
 * starts using the async API or named parameters, take the `@types/node` upgrade instead.
 */
declare module "node:sqlite" {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
