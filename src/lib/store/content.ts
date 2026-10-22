/**
 * The content side: passages, and the two questions asked of them — what to read, and what to write
 * pregenerated.
 */

import { all, bool, flag, get, newId, nowMs, run, transaction } from "./db";

export interface ParagraphRecord {
  _id: string;
  targetLang: "en" | "de";
  title: string;
  content: string;
  topic: string | null;
  wordCount: number;
  level: string | null;
  difficulty: number;
  difficultySource: string | null;
  coverage: number;
  tokenizerVersion: number;
  source: "seed" | "agent" | "import";
  briefId: string | null;
  buffered: boolean;
  /** Kept on purpose, and exempt from pruning. See the schema for why. */
  starred: boolean;
  promptSnapshot?: string | null;
  createdAt: number;
}

export interface ParagraphSummary {
  _id: string;
  title: string;
  /** The domain the passage was written for, which is what the reader shows as its heading. */
  topic: string | null;
  level: string | null;
  wordCount: number;
  source: string;
  createdAt: number;
  briefId: string | null;
  starred: boolean;
  markedCount: number;
}

interface ParagraphRow {
  id: string;
  targetLang: string;
  title: string;
  content: string;
  topic: string | null;
  wordCount: number;
  level: string | null;
  difficulty: number;
  difficultySource: string | null;
  coverage: number;
  tokenizerVersion: number;
  source: string;
  briefId: string | null;
  buffered: number;
  starred: number;
  promptSnapshot: string | null;
  createdAt: number;
}

export function toParagraph(row: ParagraphRow): ParagraphRecord {
  return {
    _id: row.id,
    targetLang: row.targetLang as "en" | "de",
    title: row.title,
    content: row.content,
    topic: row.topic,
    wordCount: row.wordCount,
    level: row.level,
    difficulty: row.difficulty,
    difficultySource: row.difficultySource,
    coverage: row.coverage,
    tokenizerVersion: row.tokenizerVersion,
    source: row.source as ParagraphRecord["source"],
    briefId: row.briefId,
    buffered: bool(row.buffered),
    // Filled in by `paragraphSummaries`, which knows the reader.
    starred: false,
    promptSnapshot: row.promptSnapshot,
    createdAt: row.createdAt,
  };
}

/**
 * The reading order: easiest first, then oldest.
 *
 * A learner new to the language should meet the simplest text available, not whatever was written
 * most recently — recency matters for the history list, not for what to read next.
 */
export function paragraphsFor(targetLang: string): ParagraphRecord[] {
  return all<ParagraphRow>(
    "SELECT * FROM paragraphs WHERE targetLang = ? ORDER BY difficulty ASC, createdAt ASC",
    targetLang,
  ).map(toParagraph);
}

export function paragraphById(id: string): ParagraphRecord | null {
  const row = get<ParagraphRow>("SELECT * FROM paragraphs WHERE id = ?", id);
  return row ? toParagraph(row) : null;
}

/**
 * The history list: newest first, with each passage's mark count.
 *
 * Kept light on purpose — no content, no spans — because the list grows without limit as the reader
 * generates, and the list needs none of it.
 */
export function paragraphSummaries(targetLang: string, userId: string): ParagraphSummary[] {
  return all<{
    id: string;
    title: string;
    topic: string | null;
    level: string | null;
    wordCount: number;
    source: string;
    createdAt: number;
    briefId: string | null;
    starred: number;
    markedCount: number;
  }>(
    `SELECT p.id, p.title, p.topic, p.level, p.wordCount, p.source, p.createdAt, p.briefId,
            COALESCE(m.n, 0) AS markedCount,
            CASE WHEN s.paragraphId IS NULL THEN 0 ELSE 1 END AS starred
     FROM paragraphs p
     LEFT JOIN (
       SELECT paragraphId, COUNT(*) AS n FROM marks
       WHERE userId = ? AND status = 'marked' GROUP BY paragraphId
     ) m ON m.paragraphId = p.id
     -- The reader's own stars, joined once for the whole list rather than per row.
     LEFT JOIN paragraph_stars s ON s.paragraphId = p.id AND s.userId = ?
     WHERE p.targetLang = ?
     ORDER BY p.createdAt DESC`,
    userId,
    userId,
    targetLang,
  ).map((row) => ({
    _id: row.id,
    title: row.title,
    topic: row.topic,
    level: row.level,
    wordCount: row.wordCount,
    source: row.source,
    createdAt: row.createdAt,
    briefId: row.briefId,
    starred: bool(row.starred),
    markedCount: row.markedCount,
  }));
}

/**
 * Insert or replace a generated passage, keyed by the brief it fulfils.
 *
 * The brief is the identity, not the title: titles are written by the model and change between runs,
 * which is how five briefs once became nine paragraphs.
 */
export function upsertParagraphByBrief(
  paragraph: Omit<ParagraphRecord, "_id" | "createdAt"> & { _id?: string },
): string {
  const existing = paragraph.briefId
    ? get<{ id: string }>(
        "SELECT id FROM paragraphs WHERE targetLang = ? AND briefId = ?",
        paragraph.targetLang,
        paragraph.briefId,
      )
    : undefined;
  const id = existing?.id ?? paragraph._id ?? newId();

  run(
    `INSERT INTO paragraphs (id, targetLang, title, content, topic, wordCount, level, difficulty,
                             difficultySource, coverage, tokenizerVersion, source, briefId, buffered,
                             starred, promptSnapshot, createdAt, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, content = excluded.content, topic = excluded.topic,
       wordCount = excluded.wordCount, level = excluded.level, difficulty = excluded.difficulty,
       difficultySource = excluded.difficultySource, coverage = excluded.coverage,
       tokenizerVersion = excluded.tokenizerVersion, source = excluded.source,
       briefId = excluded.briefId, buffered = excluded.buffered,
       starred = excluded.starred,
       promptSnapshot = excluded.promptSnapshot, updatedAt = excluded.updatedAt`,
    id,
    paragraph.targetLang,
    paragraph.title,
    paragraph.content,
    paragraph.topic ?? null,
    paragraph.wordCount,
    paragraph.level ?? null,
    paragraph.difficulty,
    paragraph.difficultySource ?? null,
    paragraph.coverage,
    paragraph.tokenizerVersion,
    paragraph.source,
    paragraph.briefId ?? null,
    flag(paragraph.buffered),
    flag(paragraph.starred),
    paragraph.promptSnapshot ?? null,
    nowMs(),
    nowMs(),
  );
  return id;
}

export function insertParagraph(paragraph: Omit<ParagraphRecord, "_id" | "createdAt">): string {
  return upsertParagraphByBrief(paragraph);
}

// ── The pregenerated stock ────────────────────────────────────────────────────

/**
 * The next stock passage at the level we actually want.
 *
 * Oldest first, so the stock is served in the order it was written, and **filtered by level**: a
 * passage written for A2 must not be served to someone the estimate now places at B2. That mismatch
 * is the whole reason the level is checked here — the stock outlives the estimate that produced it,
 * so "there is a passage in the buffer" is not the same as "there is a passage for this reader".
 * When nothing matches, the caller writes one, which is correct rather than fast.
 */
export function nextBufferedParagraph(targetLang: string, level?: string | null): ParagraphRecord | null {
  const row = level
    ? get<ParagraphRow>(
        `SELECT * FROM paragraphs WHERE targetLang = ? AND buffered = 1 AND level = ?
         ORDER BY createdAt ASC LIMIT 1`,
        targetLang,
        level,
      )
    : get<ParagraphRow>(
        "SELECT * FROM paragraphs WHERE targetLang = ? AND buffered = 1 ORDER BY createdAt ASC LIMIT 1",
        targetLang,
      );
  return row ? toParagraph(row) : null;
}

/**
 * Take a passage out of the pool, atomically.
 *
 * `nextBufferedParagraph` followed by `clearBuffered` is two statements, and two presses arriving
 * together can both read the same row before either clears it — the same passage handed to both
 * readers. The claim is one statement here, so a row can only be taken once.
 *
 * Returns the passage that was claimed, or `null` if the pool had nothing matching.
 */
export function claimBufferedParagraph(
  targetLang: string,
  level?: string | null,
): ParagraphRecord | null {
  const row = get<ParagraphRow>(
    level
      ? `UPDATE paragraphs SET buffered = 0
           WHERE id = (SELECT id FROM paragraphs
                        WHERE targetLang = ? AND buffered = 1 AND level = ?
                        ORDER BY createdAt ASC LIMIT 1)
         RETURNING *`
      : `UPDATE paragraphs SET buffered = 0
           WHERE id = (SELECT id FROM paragraphs
                        WHERE targetLang = ? AND buffered = 1
                        ORDER BY createdAt ASC LIMIT 1)
         RETURNING *`,
    ...(level ? [targetLang, level] : [targetLang]),
  );
  return row ? toParagraph(row) : null;
}

export function clearBuffered(id: string): void {
  run("UPDATE paragraphs SET buffered = 0 WHERE id = ?", id);
}

export function markBuffered(id: string): void {
  run("UPDATE paragraphs SET buffered = 1 WHERE id = ?", id);
}

export function countBuffered(targetLang: string): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM paragraphs WHERE targetLang = ? AND buffered = 1", targetLang)?.n ?? 0);
}

/** Stored passages by where they came from — the set `--verify` re-measures. */
export function paragraphsBySource(source: string): ParagraphRecord[] {
  return all<ParagraphRow>("SELECT * FROM paragraphs WHERE source = ? ORDER BY createdAt ASC", source).map(toParagraph);
}

export function paragraphByBrief(targetLang: string, briefId: string): ParagraphRecord | null {
  const row = get<ParagraphRow>(
    "SELECT * FROM paragraphs WHERE targetLang = ? AND briefId = ?",
    targetLang,
    briefId,
  );
  return row ? toParagraph(row) : null;
}

/** Flag a passage as stock. The brief is the identity, not the title. */
export function markBufferedByBrief(targetLang: string, briefId: string): void {
  run("UPDATE paragraphs SET buffered = 1 WHERE targetLang = ? AND briefId = ?", targetLang, briefId);
}

export function countParagraphs(targetLang: string): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM paragraphs WHERE targetLang = ?", targetLang)?.n ?? 0);
}


// ── Starring, and what that is for ────────────────────────────────────────────────────────────

/**
 * Kept for the one-off migration of the old global column; new stars go through `stars.ts`.
 */
export function legacyStarredIds(): string[] {
  return all<{ id: string }>("SELECT id FROM paragraphs WHERE starred = 1").map((row) => row.id);
}

/**
 * How many passages to keep per language, however forgettable.
 *
 * The reader moves forward by generating, so the list only grows. Beyond a screenful or two of
 * history nothing is ever revisited, and the ones worth revisiting are either still marked or
 * starred.
 */
export const HISTORY_KEEP = 30;

/**
 * Forget old passages that carry nothing.
 *
 * Three conditions, all required: older than the newest `HISTORY_KEEP`, no marks at all, and not
 * starred. The reasoning is the app's own premise — reading past a word without marking it counts as
 * knowing it — so a passage with no marks is one the reader already knew, and an old one they knew is
 * the least valuable thing in the database.
 *
 * Marks are *not* permanent: unmarking retracts one. So a passage loses its protection as its marks
 * are retracted, which is intended and is why the check is against the current mark rows rather than
 * against a stored count.
 *
 * Pregenerated stock is excluded: it is inventory rather than history, it is unread by definition,
 * and pruning it would only make the next press wait for a new passage to be written.
 *
 * Event rows are deliberately left alone. They are the evidence log the learner model folds, they
 * reference the passage only for provenance, and deleting evidence to tidy up a list would change
 * how well the app knows the reader.
 *
 * Returns the ids removed, so a caller can report rather than guess.
 */
export function pruneUnmarked(targetLang: string, keep = HISTORY_KEEP): string[] {
  const candidates = all<{ id: string }>(
    `SELECT id FROM paragraphs
     WHERE targetLang = ? AND buffered = 0
       AND id NOT IN (SELECT paragraphId FROM paragraph_stars)
       AND id NOT IN (SELECT paragraphId FROM marks WHERE paragraphId IS NOT NULL)
       AND id NOT IN (
         SELECT id FROM paragraphs WHERE targetLang = ? ORDER BY createdAt DESC LIMIT ?
       )`,
    targetLang,
    targetLang,
    keep,
  );
  if (candidates.length === 0) return [];
  const ids = candidates.map((row) => row.id);
  transaction(() => {
    for (const id of ids) run("DELETE FROM paragraphs WHERE id = ?", id);
  });
  return ids;
}
