/**
 * The Pi's side of the pull: fetch evidence from Cloudflare, re-estimate, write the estimate back.
 *
 * Identity lives in D1 and so does what a reader did there; the estimator lives here, because this is
 * where the evidence model and the vocabulary are. So this process runs on a timer: it asks for events
 * after a cursor, folds them into the learners they belong to, and pushes the resulting ability back.
 *
 * The cursor is D1's `rowid`, kept in a local file rather than a table so a fresh clone starts from the
 * beginning rather than from "now" and silently skipping history.
 *
 *   npm run pull              one pass, then exit (what a timer should run)
 *   npm run pull -- --drain   keep pulling until the queue is empty
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { all, get, openDatabase, run } from "../../lib/store/db";
import { recomputeAllAbilities } from "../../lib/learner/profile";
import { loadEnv } from "../env";

const CURSOR = path.resolve(process.cwd(), "data/d1-cursor.json");

interface ServiceConfig {
  url: string;
  secret: string;
}

function service(env: Record<string, string>): ServiceConfig {
  const url = env.FLOWWING_IDENTITY_URL;
  const secret = env.FLOWWING_IDENTITY_SECRET;
  if (!url || !secret) {
    throw new Error(
      "FLOWWING_IDENTITY_URL and FLOWWING_IDENTITY_SECRET must be set: the pull talks to Cloudflare",
    );
  }
  return { url: url.replace(/\/$/, ""), secret };
}

async function call<T>(config: ServiceConfig, pathName: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.url}/api/service${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Flowwing-Service": config.secret,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${pathName}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

interface RemoteEvent {
  cursor: number;
  id: string;
  userId: string;
  targetLang: string;
  type: string;
  source: string;
  sessionId: string | null;
  paragraphId: string | null;
  wordId: string | null;
  surface: string | null;
  lemmaKey: string | null;
  charStart: number | null;
  charEnd: number | null;
  items: string | null;
  ts: number;
}

async function readCursor(): Promise<number> {
  try {
    return JSON.parse(await readFile(CURSOR, "utf8")).cursor ?? 0;
  } catch {
    return 0;
  }
}

async function writeCursor(cursor: number): Promise<void> {
  await writeFile(CURSOR, JSON.stringify({ cursor, at: new Date().toISOString() }, null, 2) + "\n");
}

/** Copy one remote event in, keeping its id so a re-read is harmless. */
function importEvent(event: RemoteEvent): void {
  run(
    `INSERT INTO events (id, userId, targetLang, type, source, sessionId, paragraphId, wordId,
                         surface, lemmaKey, charStart, charEnd, items, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
    event.id,
    event.userId,
    event.targetLang,
    event.type,
    event.source ?? "web",
    event.sessionId,
    event.paragraphId,
    event.wordId,
    event.surface,
    event.lemmaKey,
    event.charStart,
    event.charEnd,
    event.items,
    event.ts,
  );
}

async function onePass(config: ServiceConfig, drain: boolean): Promise<{ events: number; estimates: number }> {
  let cursor = await readCursor();
  let imported = 0;
  const touched = new Set<string>();

  for (;;) {
    const page = await call<{ events: RemoteEvent[]; cursor: number; more: boolean }>(
      config,
      `/events?since=${cursor}&limit=500`,
    );
    if (page.events.length === 0) break;

    for (const event of page.events) {
      importEvent(event);
      touched.add(event.userId);
      imported += 1;
    }
    cursor = page.cursor;
    await writeCursor(cursor);
    if (!drain && !page.more) break;
    if (!page.more) break;
  }

  // Only the learners who did something need re-estimating.
  let estimates = 0;
  for (const userId of touched) {
    const views = await recomputeAllAbilities(userId);
    for (const view of views) {
      const row = get<{ theta: number; se: number; n: number; level: string | null; levelLow: string; levelHigh: string; priorTheta: number | null }>(
        "SELECT theta, se, n, level, levelLow, levelHigh, priorTheta FROM ability_states WHERE userId = ? AND targetLang = ?",
        userId,
        view.targetLang,
      );
      if (!row) continue;
      await call(config, "/ability", {
        method: "POST",
        body: JSON.stringify({ userId, targetLang: view.targetLang, ...row }),
      });
      estimates += 1;
    }
  }

  return { events: imported, estimates };
}

/** One pass over the queue, for callers that already have a process and a config. */
export async function onePullPass(): Promise<{ events: number; estimates: number }> {
  const env = loadEnv();
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return onePass(service(env), false);
}

async function main(): Promise<void> {
  const env = loadEnv();
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  openDatabase();
  const config = service(env);
  const drain = process.argv.includes("--drain");

  const started = Date.now();
  const result = await onePass(config, drain);
  console.log(
    `pull: ${result.events} event${result.events === 1 ? "" : "s"} · ` +
      `${result.estimates} estimate${result.estimates === 1 ? "" : "s"} written back · ` +
      `cursor ${await readCursor()} · ${Date.now() - started}ms`,
  );
}

// Only run as a CLI when invoked directly, so importing it from the server does not start a pass.
if (process.argv[1] && process.argv[1].endsWith("pull.ts")) {
  main().catch((error) => {
    console.error(`pull failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
