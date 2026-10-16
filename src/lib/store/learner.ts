/**
 * The learner side: who they are, what they marked, and what the event log says about their ability.
 *
 * The event table is append-only and is the truth; `word_states` and `ability_states` are caches
 * derived from it. That distinction was the point of the Phase 2 work and it survives the move — the
 * only thing that changed is where the rows live.
 */

import { all, get, json, newId, nowMs, placeholders, run } from "./db";

const DEFAULT_TRACK = "zh-en";

export interface UserRecord {
  _id: string;
  userId: string;
  track: string;
  uiLocale: string;
}

export function userByUserId(userId: string): UserRecord | null {
  const row = get<{ id: string; userId: string; track: string; uiLocale: string }>(
    "SELECT id, userId, track, uiLocale FROM users WHERE userId = ?",
    userId,
  );
  return row ? { _id: row.id, userId: row.userId, track: row.track, uiLocale: row.uiLocale } : null;
}

/** Resolve or create, which is what the cookie middleware needs on every request. */
export function ensureUser(userId: string, track = DEFAULT_TRACK, uiLocale = "en"): UserRecord {
  const existing = userByUserId(userId);
  if (existing) return existing;
  const id = newId();
  run(
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

export function setUserTrack(userId: string, track: string): UserRecord | null {
  run("UPDATE users SET track = ?, updatedAt = ? WHERE userId = ?", track, nowMs(), userId);
  return userByUserId(userId);
}

// ── Marks ─────────────────────────────────────────────────────────────────────

/** This learner's marks on one passage, keyed by where they made them — what the tint reads. */
export function marksForParagraph(userId: string, paragraphId: string): Record<string, string> {
  const rows = all<{ charStart: number; status: string }>(
    "SELECT charStart, status FROM marks WHERE userId = ? AND paragraphId = ?",
    userId,
    paragraphId,
  );
  const marked: Record<string, string> = {};
  for (const row of rows) marked[`${row.charStart}`] = row.status;
  return marked;
}

/** Words in one state, most unfamiliar first — the list behind "words I have marked". */
export function wordStatesByStatus(
  userId: string,
  targetLang: string,
  status: string,
  limit: number,
): WordStateRecord[] {
  return all<WordStateRecord & { lemmaKey: string }>(
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
export function setMarkStatus(
  userId: string,
  paragraphId: string,
  charStart: number,
  charEnd: number,
  status: string,
): void {
  run(
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

export function upsertMark(mark: MarkInput): void {
  run(
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

export function markCount(userId: string, targetLang: string, status = "marked"): number {
  return Number(
    get<{ n: number }>(
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

export function insertEvent(event: EventInput): string {
  const id = newId();
  run(
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
export function eventsFor(
  userId: string,
  targetLang: string,
  sinceMs: number,
  limit: number,
): EventRecord[] {
  const rows = all<{ type: string; lemmaKey: string | null; items: string | null; sessionId: string | null; ts: number }>(
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
export function countExposureItems(userId: string, targetLang: string, lemmaKey: string): number {
  return Number(
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events, json_each(events.items)
       WHERE events.userId = ? AND events.targetLang = ? AND events.type = 'exposure'
         AND json_extract(json_each.value, '$.lemmaKey') = ?`,
      userId,
      targetLang,
      lemmaKey,
    )?.n ?? 0,
  );
}

export function countEvents(userId?: string): number {
  return userId
    ? Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE userId = ?", userId)?.n ?? 0)
    : Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM events")?.n ?? 0);
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

export function wordStatesFor(userId: string, targetLang: string, keys: string[]): Map<string, WordStateRecord> {
  if (keys.length === 0) return new Map();
  const rows = all<WordStateRecord & { lemmaKey: string }>(
    `SELECT lemmaKey, status, timesMet, unfamiliarity, lookupCount, exposureCount FROM word_states
     WHERE userId = ? AND targetLang = ? AND lemmaKey IN (${placeholders(keys.length)})`,
    userId,
    targetLang,
    ...keys,
  );
  return new Map(rows.map((row) => [row.lemmaKey, row]));
}

export function upsertWordState(
  userId: string,
  targetLang: string,
  state: WordStateRecord & { wordId: string },
): void {
  run(
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

export function abilityFor(userId: string, targetLang: string): AbilityRecord | null {
  const row = get<AbilityRecord & { targetLang: string }>(
    `SELECT targetLang, theta, se, n, level, levelLow, levelHigh, priorTheta FROM ability_states
     WHERE userId = ? AND targetLang = ?`,
    userId,
    targetLang,
  );
  return row ?? null;
}

export function abilitiesFor(userId: string): AbilityRecord[] {
  return all<AbilityRecord>(
    `SELECT targetLang, theta, se, n, level, levelLow, levelHigh, priorTheta FROM ability_states
     WHERE userId = ? ORDER BY targetLang ASC`,
    userId,
  );
}

export function upsertAbility(userId: string, ability: AbilityRecord): void {
  run(
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
export function anyAbilityUser(): string {
  return String(
    get<{ userId: string }>("SELECT userId FROM ability_states WHERE n > 0 ORDER BY updatedAt DESC LIMIT 1")
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

export function insertPlacementSession(row: {
  userId: string;
  targetLang: string;
  seed: number;
  items: unknown[];
}): string {
  const id = newId();
  run(
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

export function placementSessionById(userId: string, id: string): PlacementRecord | null {
  const row = get<{
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
export function latestCompletedPlacement(userId: string, targetLang: string): PlacementRecord | null {
  const row = get<{
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

export function completePlacementSession(
  id: string,
  responses: unknown[],
  score: unknown,
): void {
  run(
    "UPDATE placement_sessions SET responses = ?, score = ?, completedAt = ? WHERE id = ?",
    JSON.stringify(responses),
    JSON.stringify(score),
    nowMs(),
    id,
  );
}
