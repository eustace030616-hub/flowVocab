/**
 * The learner side: who they are, what they marked, and what the event log says about their ability.
 *
 * The event table is append-only and is the truth; `word_states` and `ability_states` are caches
 * derived from it. That distinction was the point of the Phase 2 work and it survives the move — the
 * only thing that changed is where the rows live.
 */

import type { StoreDriver } from "./driver";
import { all, get, json, newId, nowMs, placeholders, run } from "./db";

const DEFAULT_TRACK = "zh-en";

export interface UserRecord {
  _id: string;
  userId: string;
  track: string;
  uiLocale: string;
}

export async function userByUserId(userId: string, store: StoreDriver): Promise<UserRecord | null> {
  const row = await store.get<{ id: string; userId: string; track: string; uiLocale: string }>(
    "SELECT id, userId, track, uiLocale FROM users WHERE userId = ?",
    userId,
  );
  return row ? { _id: row.id, userId: row.userId, track: row.track, uiLocale: row.uiLocale } : null;
}

/** Resolve or create, which is what the cookie middleware needs on every request. */
export async function ensureUser(userId: string, track = DEFAULT_TRACK, uiLocale = "en", store: StoreDriver): Promise<UserRecord> {
  const existing = await userByUserId(userId);
  if (existing) return existing;
  const id = newId();
  await store.run(
    "INSERT INTO users (id, userId, track, uiLocale, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
    id,
    userId,
    track,
    uiLocale,
    nowMs(),
    nowMs(),
  );
  return { _id: id, userId, track, uiLocale };
}

export async function setUserTrack(userId: string, track: string, store: StoreDriver): Promise<UserRecord | null> {
  await store.run("UPDATE users SET track = ?, updatedAt = ? WHERE userId = ?", track, nowMs(), userId);
  return await userByUserId(userId);
}

// ── Marks ─────────────────────────────────────────────────────────────────────

/** This learner's marks on one passage, keyed by where they made them — what the tint reads. */
export async function marksForParagraph(userId: string, paragraphId: string, store: StoreDriver): Promise<Record<string, string>> {
  const rows = await store.all<{ charStart: number; status: string }>(
    "SELECT charStart, status FROM marks WHERE userId = ? AND paragraphId = ?",
    userId,
    paragraphId,
  );
  const marked: Record<string, string> = {};
  for (const row of rows) marked[`${row.charStart}`] = row.status;
  return marked;
}

/** Words in one state, most unfamiliar first — the list behind "words I have marked". */
export async function wordStatesByStatus(userId: string,
  targetLang: string,
  status: string,
  limit: number, store: StoreDriver): Promise<WordStateRecord[]> {
  return await store.all<WordStateRecord & { lemmaKey: string }>(
    `SELECT lemmaKey, status, timesMet, unfamiliarity, lookupCount, exposureCount FROM word_states
     WHERE userId = ? AND targetLang = ? AND status = ?
     ORDER BY unfamiliarity DESC LIMIT ?`,
    userId,
    targetLang,
    status,
    limit,
  );
}

/** Change an existing mark's status without touching the ones that are not there. */
export async function setMarkStatus(userId: string,
  paragraphId: string,
  charStart: number,
  charEnd: number,
  status: string, store: StoreDriver): Promise<void> {
  await store.run(
    `UPDATE marks SET status = ?, markedAt = ?
     WHERE userId = ? AND paragraphId = ? AND charStart = ? AND charEnd = ?`,
    status,
    nowMs(),
    userId,
    paragraphId,
    charStart,
    charEnd,
  );
}

export interface MarkInput {
  userId: string;
  targetLang: string;
  paragraphId: string;
  wordId: string;
  surface: string;
  lemmaKey: string;
  charStart: number;
  charEnd: number;
  tokenizerVersion: number;
  status: string;
}

export async function upsertMark(mark: MarkInput, store: StoreDriver): Promise<void> {
  await store.run(
    `INSERT INTO marks (id, userId, targetLang, paragraphId, wordId, surface, lemmaKey, charStart,
                        charEnd, tokenizerVersion, status, markedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(userId, paragraphId, charStart, charEnd) DO UPDATE SET
       status = excluded.status, lemmaKey = excluded.lemmaKey, wordId = excluded.wordId,
       surface = excluded.surface, markedAt = excluded.markedAt`,
    newId(),
    mark.userId,
    mark.targetLang,
    mark.paragraphId,
    mark.wordId,
    mark.surface,
    mark.lemmaKey,
    mark.charStart,
    mark.charEnd,
    mark.tokenizerVersion,
    mark.status,
    nowMs(),
  );
}

export async function markCount(userId: string, targetLang: string, status = "marked", store: StoreDriver): Promise<number> {
  return Number(
    await store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM marks WHERE userId = ? AND targetLang = ? AND status = ?",
      userId,
      targetLang,
      status,
    )?.n ?? 0,
  );
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface EventInput {
  userId: string;
  targetLang: string;
  type: string;
  source?: string;
  sessionId?: string | null;
  paragraphId?: string | null;
  wordId?: string | null;
  surface?: string | null;
  lemmaKey?: string | null;
  charStart?: number | null;
  charEnd?: number | null;
  items?: Array<{ lemmaKey: string }> | null;
}

export async function insertEvent(event: EventInput, store: StoreDriver): Promise<string> {
  const id = newId();
  await store.run(
    `INSERT INTO events (id, userId, targetLang, type, source, sessionId, paragraphId, wordId,
                         surface, lemmaKey, charStart, charEnd, items, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    event.userId,
    event.targetLang,
    event.type,
    event.source ?? "web",
    event.sessionId ?? null,
    event.paragraphId ?? null,
    event.wordId ?? null,
    event.surface ?? null,
    event.lemmaKey ?? null,
    event.charStart ?? null,
    event.charEnd ?? null,
    event.items ? JSON.stringify(event.items) : null,
    nowMs(),
  );
  return id;
}

export interface EventRecord {
  type: string;
  lemmaKey: string | null;
  items: Array<{ lemmaKey: string }> | null;
  sessionId: string | null;
  ts: number;
}

/**
 * The events the ability fold reads: one learner, one language, inside the window.
 *
 * Bounded by time and count because evidence beyond a few half-lives cannot change the answer, and
 * reading it made every page load cost grow with the learner's whole history.
 */
export async function eventsFor(userId: string,
  targetLang: string,
  sinceMs: number,
  limit: number, store: StoreDriver): Promise<EventRecord[]> {
  const rows = await store.all<{ type: string; lemmaKey: string | null; items: string | null; sessionId: string | null; ts: number }>(
    `SELECT type, lemmaKey, items, sessionId, ts FROM events
     WHERE userId = ? AND targetLang = ? AND ts >= ?
     ORDER BY ts DESC LIMIT ?`,
    userId,
    targetLang,
    sinceMs,
    limit,
  );
  return rows.map((row) => ({
    type: row.type,
    lemmaKey: row.lemmaKey,
    items: json<Array<{ lemmaKey: string }> | null>(row.items, null),
    sessionId: row.sessionId,
    ts: row.ts,
  }));
}

/**
 * How many exposure batches carried this word.
 *
 * Exposures are stored one row per paragraph view with an `items` array, so this reaches inside the
 * JSON rather than unfolding thousands of rows in JavaScript — the same question the documents
 * answered with `"items.lemmaKey"`.
 */
export async function countExposureItems(userId: string, targetLang: string, lemmaKey: string, store: StoreDriver): Promise<number> {
  return Number(
    await store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events, json_each(events.items)
       WHERE events.userId = ? AND events.targetLang = ? AND events.type = 'exposure'
         AND json_extract(json_each.value, '$.lemmaKey') = ?`,
      userId,
      targetLang,
      lemmaKey,
    )?.n ?? 0,
  );
}

export async function countEvents(userId?: string, store: StoreDriver): Promise<number> {
  return userId
    ? Number(await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE userId = ?", userId)?.n ?? 0)
    : Number(await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")?.n ?? 0);
}

// ── Derived state ─────────────────────────────────────────────────────────────

export interface WordStateRecord {
  lemmaKey: string;
  status: string;
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;
}

export async function wordStatesFor(userId: string, targetLang: string, keys: string[], store: StoreDriver): Promise<Map<string, WordStateRecord>> {
  if (keys.length === 0) return new Map();
  const rows = await store.all<WordStateRecord & { lemmaKey: string }>(
    `SELECT lemmaKey, status, timesMet, unfamiliarity, lookupCount, exposureCount FROM word_states
     WHERE userId = ? AND targetLang = ? AND lemmaKey IN (${placeholders(keys.length)})`,
    userId,
    targetLang,
    ...keys,
  );
  return new Map(rows.map((row) => [row.lemmaKey, row]));
}

export async function upsertWordState(userId: string,
  targetLang: string,
  state: WordStateRecord & { wordId: string }, store: StoreDriver): Promise<void> {
  await store.run(
    `INSERT INTO word_states (id, userId, targetLang, lemmaKey, wordId, status, timesMet, unfamiliarity,
                              lookupCount, exposureCount, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(userId, targetLang, lemmaKey) DO UPDATE SET
       status = excluded.status, timesMet = excluded.timesMet, unfamiliarity = excluded.unfamiliarity,
       lookupCount = excluded.lookupCount, exposureCount = excluded.exposureCount,
       updatedAt = excluded.updatedAt`,
    newId(),
    userId,
    targetLang,
    state.lemmaKey,
    state.wordId,
    state.status,
    state.timesMet,
    state.unfamiliarity,
    state.lookupCount,
    state.exposureCount,
    nowMs(),
  );
}

export interface AbilityRecord {
  targetLang: string;
  theta: number;
  se: number;
  n: number;
  level: string | null;
  levelLow: string;
  levelHigh: string;
  priorTheta: number | null;
}

export async function abilityFor(userId: string, targetLang: string, store: StoreDriver): Promise<AbilityRecord | null> {
  const row = await store.get<AbilityRecord & { targetLang: string }>(
    `SELECT targetLang, theta, se, n, level, levelLow, levelHigh, priorTheta FROM ability_states
     WHERE userId = ? AND targetLang = ?`,
    userId,
    targetLang,
  );
  return row ?? null;
}

export async function abilitiesFor(userId: string, store: StoreDriver): Promise<AbilityRecord[]> {
  return await store.all<AbilityRecord>(
    `SELECT targetLang, theta, se, n, level, levelLow, levelHigh, priorTheta FROM ability_states
     WHERE userId = ? ORDER BY targetLang ASC`,
    userId,
  );
}

export async function upsertAbility(userId: string, ability: AbilityRecord, store: StoreDriver): Promise<void> {
  await store.run(
    `INSERT INTO ability_states (id, userId, targetLang, theta, se, n, level, levelLow, levelHigh, priorTheta, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(userId, targetLang) DO UPDATE SET
       theta = excluded.theta, se = excluded.se, n = excluded.n, level = excluded.level,
       levelLow = excluded.levelLow, levelHigh = excluded.levelHigh, priorTheta = excluded.priorTheta,
       updatedAt = excluded.updatedAt`,
    newId(),
    userId,
    ability.targetLang,
    ability.theta,
    ability.se,
    ability.n,
    ability.level,
    ability.levelLow,
    ability.levelHigh,
    ability.priorTheta,
    nowMs(),
  );
}

/**
 * Any learner who has an estimate, for work that belongs to nobody in particular.
 *
 * Pregenerated stock is written for the level of whoever is using the app rather than for a specific
 * account, so it needs a representative estimate and not a user id.
 */
export async function anyAbilityUser(store: StoreDriver): Promise<string> {
  return String(
    await store.get<{ userId: string }>("SELECT userId FROM ability_states WHERE n > 0 ORDER BY updatedAt DESC LIMIT 1")
      ?.userId ?? "",
  );
}

// ── Placement ─────────────────────────────────────────────────────────────────

export interface PlacementRecord {
  _id: string;
  userId: string;
  targetLang: string;
  seed: number;
  items: unknown[];
  responses: unknown[];
  completedAt: number | null;
  score: unknown;
}

export async function insertPlacementSession(row: {
  userId: string;
  targetLang: string;
  seed: number;
  items: unknown[];
}, store: StoreDriver): Promise<string> {
  const id = newId();
  await store.run(
    "INSERT INTO placement_sessions (id, userId, targetLang, seed, items, responses, completedAt, score, createdAt) VALUES (?,?,?,?,?,?,?,?,?)",
    id,
    row.userId,
    row.targetLang,
    row.seed,
    JSON.stringify(row.items),
    "[]",
    null,
    null,
    nowMs(),
  );
  return id;
}

export async function placementSessionById(userId: string, id: string, store: StoreDriver): Promise<PlacementRecord | null> {
  const row = await store.get<{
    id: string;
    userId: string;
    targetLang: string;
    seed: number;
    items: string;
    responses: string;
    completedAt: number | null;
    score: string | null;
  }>("SELECT * FROM placement_sessions WHERE id = ? AND userId = ?", id, userId);
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.userId,
    targetLang: row.targetLang,
    seed: row.seed,
    items: json<unknown[]>(row.items, []),
    responses: json<unknown[]>(row.responses, []),
    completedAt: row.completedAt,
    score: json<unknown>(row.score, null),
  };
}

/** The newest completed test: a retake replaces the previous evidence rather than averaging with it. */
export async function latestCompletedPlacement(userId: string, targetLang: string, store: StoreDriver): Promise<PlacementRecord | null> {
  const row = await store.get<{
    id: string;
    userId: string;
    targetLang: string;
    seed: number;
    items: string;
    responses: string;
    completedAt: number | null;
    score: string | null;
  }>(
    `SELECT * FROM placement_sessions WHERE userId = ? AND targetLang = ? AND completedAt IS NOT NULL
     ORDER BY createdAt DESC LIMIT 1`,
    userId,
    targetLang,
  );
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.userId,
    targetLang: row.targetLang,
    seed: row.seed,
    items: json<unknown[]>(row.items, []),
    responses: json<unknown[]>(row.responses, []),
    completedAt: row.completedAt,
    score: json<unknown>(row.score, null),
  };
}

/**
 * Save progress on a running test, without completing it.
 *
 * `completePlacementSession` stamps `completedAt`, which is what marks a test as finished and lets
 * the estimate fold it in. An answer is not a finish: stamping it on every answer would have the
 * ability fold read a half-finished test as a measurement, and the next `latestCompletedPlacement`
 * would return it.
 */
export async function savePlacementProgress(id: string, responses: unknown[], items?: unknown[], store: StoreDriver): Promise<void> {
  if (items) {
    await store.run(
      "UPDATE placement_sessions SET responses = ?, items = ? WHERE id = ?",
      JSON.stringify(responses),
      JSON.stringify(items),
      id,
    );
    return;
  }
  await store.run("UPDATE placement_sessions SET responses = ? WHERE id = ?", JSON.stringify(responses), id);
}

export async function completePlacementSession(id: string,
  responses: unknown[],
  score: unknown, store: StoreDriver): Promise<void> {
  await store.run(
    "UPDATE placement_sessions SET responses = ?, score = ?, completedAt = ? WHERE id = ?",
    JSON.stringify(responses),
    JSON.stringify(score),
    nowMs(),
    id,
  );
}
