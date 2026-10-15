/**
 * Reading local configuration without leaking it.
 *
 * The API key lives in `.env.local` (gitignored). This reads that file **inside the process that
 * needs the value** and hands it straight to the request, so it never reaches a command line, a log
 * line, or any output. Nothing here prints a value; `describe()` reports presence and length only.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvFile(file: string): Record<string, string> {
  const text = readFileSync(file, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** `.env.local` first, then `.env`, then the ambient environment. */
export function loadEnv(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const file = path.join(process.cwd(), name);
    if (existsSync(file)) Object.assign(merged, parseEnvFile(file));
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") merged[key] = value;
  }
  return merged;
}

/**
 * Describe a credential by existence and length, never by content.
 *
 * The rule the whole session runs on: a credential is identified by where it came from and how long
 * it is. Anything that prints it — a debug line, an error message, a curl command — has leaked it.
 */
export function describeSecret(name: string, value: string | undefined): string {
  return value ? `${name}: configured (${value.length} chars, from .env.local)` : `${name}: absent`;
}
