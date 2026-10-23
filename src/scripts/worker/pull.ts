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
import { knownProbabilities } from "../../lib/learner/reading";
import { unknownWords } from "../../lib/learner/band";
import { coverageOf } from "../../lib/learner/coverage";
import { packageFor } from "../../lib/content/pack";
import { generateOne, importParagraph } from "../generate/generate";
import { BRIEFS, briefIdOf, type BriefSpec } from "../generate/briefs";
import { pickTopic } from "../generate/topics";
import { deepseekProvider } from "../generate/provider";
import type { CefrLevel, TargetLang } from "../../lib/lang";
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

/**
 * Write the Pi's reading of each passage these learners touched.
 *
 * The unknown count is a function of the whole evidence, and this is the only place that can fold it.
 * Until this runs for a passage, the reader shows the model prediction and says so.
 */
async function pushBands(config: ServiceConfig, users: Set<string>): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  for (const userId of users) {
    const read = all<{ paragraphId: string; targetLang: string }>(
      `SELECT DISTINCT paragraphId, targetLang FROM events
        WHERE userId = ? AND paragraphId IS NOT NULL AND paragraphId <> ''`,
      userId,
    );
    for (const item of read) {
      const pack = packageFor(item.paragraphId);
      if (!pack) continue;
      const spans = pack.spans as unknown as Parameters<typeof unknownWords>[0];
      const keys = [...new Set(Object.keys(pack.vocabulary))];
      const known = await knownProbabilities(userId, item.targetLang as TargetLang, keys, {
        difficulties: new Map(Object.entries(pack.vocabulary).map(([key, entry]) => [key, entry.difficulty])),
      });
      const marked = new Set(
        all<{ lemmaKey: string }>("SELECT lemmaKey FROM marks WHERE userId = ? AND paragraphId = ?", userId, item.paragraphId).map(
          (m) => m.lemmaKey,
        ),
      );
      const unknown = unknownWords(spans, {
        pKnownOf: (key: string) => known.probabilities.get(key),
        marked: (span: { lemmaKey: string }) => marked.has(span.lemmaKey),
      } as never);
      const coverage = coverageOf(spans, (key: string) => known.probabilities.get(key) ?? 1);
      rows.push({
        userId,
        paragraphId: item.paragraphId,
        targetLang: item.targetLang,
        unknownCount: unknown.count,
        coverage: coverage.coverage,
      });
    }
  }
  if (rows.length === 0) return 0;
  await call(config, "/bands", { method: "POST", body: JSON.stringify({ rows }) });
  return rows.length;
}

/**
 * Fill the pool: when the stock for a language and level is shallow, write one more passage and push it.
 *
 * The Pi generates because it has the vocabulary and the rubric; Cloudflare stores because it serves.
 * A failure is not fatal — the next tick tries again, and reading never waits on it.
 */
async function fillPool(config: ServiceConfig): Promise<number> {
  const target = Number(process.env.FLOWWING_POOL_TARGET ?? 3);
  const all: Array<[TargetLang, CefrLevel]> = [
    ["de", "A2"], ["de", "B1"], ["de", "B2"],
    ["en", "A2"], ["en", "B1"], ["en", "B2"],
  ];
  // `FLOWWING_POOL_LEVELS=de:B2` narrows the fill, which is what a test wants and a nightly run does not.
  const only = process.env.FLOWWING_POOL_LEVELS?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const levels = only ? all.filter(([lang, level]) => only.includes(`${lang}:${level}`)) : all;

  const remote = await call<{ depth: Array<{ targetLang: string; level: string | null; depth: number }> }>(config, "/pool");
  let filled = 0;

  for (const [targetLang, level] of levels) {
    const depth = remote.depth.find((row) => row.targetLang === targetLang && row.level === level)?.depth ?? 0;
    if (depth >= target) continue;

    const spec = specFor(targetLang, level);
    if (!spec) continue;

    const provider = deepseekProvider();
    const outcome = await generateOne(provider, {
      ...spec,
      // A fresh identity, so this adds to the stock instead of replacing the brief it came from.
      briefId: `${briefIdOf(spec)}:${Date.now()}`,
    });
    if (!outcome.passed || !outcome.content) {
      // Say why, rather than letting `importParagraph` report "nothing to import" and hide the reason.
      console.warn(`  pool: ${targetLang}/${level} not accepted — ${outcome.issues.slice(0, 2).join("; ") || "no content"}`);
      continue;
    }
    const paragraphId = await importParagraph(outcome);
    const pack = packageFor(paragraphId);
    const paragraph = get<Record<string, unknown>>("SELECT * FROM paragraphs WHERE id = ?", paragraphId);
    if (!pack || !paragraph) continue;
    // A pooled passage is *stock*: it counts toward the depth the next tick measures. Without this the
    // fill would generate forever and the pool would never appear to fill.
    run("UPDATE paragraphs SET buffered = 1 WHERE id = ?", paragraphId);
    await call(config, "/passages", {
      method: "POST",
      body: JSON.stringify({ paragraph: { ...paragraph, buffered: 1 }, package: pack }),
    });
    filled += 1;
    console.log(`  pool: wrote ${targetLang}/${level} ${String(paragraph.title ?? "")} (was ${depth}/${target})`);
  }
  return filled;
}

/**
 * Drain the queue of passages readers asked for.
 *
 * The button on Cloudflare writes a row; this writes the passage. One at a time, oldest first, so a
 * burst of requests does not become a burst of model calls.
 */

/**
 * The spec for a new passage: the brief for this language and level, with a topic nothing recent used.
 *
 * The brief alone is one scenario per language and level, and reusing it made eight consecutive German
 * B1 passages the same story about a late train.
 */
function specFor(targetLang: TargetLang, level: CefrLevel): BriefSpec | null {
  const brief = BRIEFS.find((entry) => entry.targetLang === targetLang && entry.level === level);
  if (!brief) return null;
  const used = all<{ topic: string }>(
    "SELECT DISTINCT topic FROM paragraphs WHERE targetLang = ? AND level = ? AND topic IS NOT NULL",
    targetLang,
    level,
  ).map((row) => row.topic);
  const topic = pickTopic(targetLang, level, used);
  return { ...brief, topic: topic || brief.topic };
}

async function serveRequests(config: ServiceConfig): Promise<number> {
  const pending = await call<{ requests: Array<{ id: string; targetLang: string; level: string | null }> }>(
    config,
    "/requests",
  );
  let served = 0;
  for (const request of pending.requests) {
    const targetLang = request.targetLang as TargetLang;
    const level = (request.level ?? "B1") as CefrLevel;
    const spec = specFor(targetLang, level);
    if (!spec) continue;
    try {
      const outcome = await generateOne(deepseekProvider(), {
        ...spec,
        briefId: `${briefIdOf(spec)}:request:${request.id}`,
      });
      if (!outcome.passed || !outcome.content) {
        console.warn(`  request ${request.id}: not accepted — ${outcome.issues.slice(0, 1).join("") || "no content"}`);
        await call(config, "/requests/decline", { method: "POST", body: JSON.stringify({ id: request.id }) });
        continue;
      }
      const paragraphId = await importParagraph(outcome);
      const pack = packageFor(paragraphId);
      const paragraph = get<Record<string, unknown>>("SELECT * FROM paragraphs WHERE id = ?", paragraphId);
      if (!pack || !paragraph) continue;
      await call(config, "/passages", {
        method: "POST",
        body: JSON.stringify({ paragraph: { ...paragraph, buffered: 0 }, package: pack }),
      });
      await call(config, "/requests/done", { method: "POST", body: JSON.stringify({ id: request.id }) });
      served += 1;
      console.log(`  request ${request.id}: wrote ${String(paragraph.title ?? "")} (${targetLang}/${level})`);
    } catch (error) {
      console.warn(`  request ${request.id} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return served;
}

async function onePass(
  config: ServiceConfig,
  drain: boolean,
): Promise<{ events: number; estimates: number; bands: number; filled: number; requested: number }> {
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

  const bands = await pushBands(config, touched);
  const requested = await serveRequests(config);
  // The pool is not this loop's business any more: `pool.ts` mirrors the Pi's pool into D1, and this one
  // only drains what a reader explicitly asked for.
  return { events: imported, estimates, bands, filled: 0, requested };
}

/** One pass over the queue, for callers that already have a process and a config. */
export async function onePullPass(): Promise<{ events: number; estimates: number; bands: number; filled: number; requested: number }> {
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
    `pull: ${result.events} events · ${result.estimates} estimates · ` +
      `${result.bands} bands · ${result.filled} pooled · ${result.requested} requested · ` +
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
