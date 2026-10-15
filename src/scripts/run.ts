/**
 * Entry-point guard for the CLI scripts.
 *
 * Without this, importing a script for its pure functions also executes its `main()` — which
 * means the test suite tries to open a database connection just to unit-test a CSV parser.
 * That is both slow and wrong: a module should be importable without side effects.
 */

import { pathToFileURL } from "node:url";

export function isEntryPoint(metaUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return pathToFileURL(invoked).href === metaUrl;
  } catch {
    return false;
  }
}

export function runIfEntry(metaUrl: string, main: () => Promise<void>): void {
  if (!isEntryPoint(metaUrl)) return;
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
