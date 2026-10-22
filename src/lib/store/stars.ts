/**
 * Stars, per reader.
 *
 * They were a column on the passage until two accounts existed, at which point the isolation test
 * showed one person's star on the other's copy. A star is an opinion about a passage — "keep this
 * one" — so it belongs to the reader who holds it, like a mark does.
 */

import { all, get, nowMs, run } from "./db";

export function setStar(userId: string, paragraphId: string, starred: boolean): void {
  if (starred) {
    run(
      "INSERT INTO paragraph_stars (userId, paragraphId, createdAt) VALUES (?,?,?) ON CONFLICT DO NOTHING",
      userId,
      paragraphId,
      nowMs(),
    );
    return;
  }
  run("DELETE FROM paragraph_stars WHERE userId = ? AND paragraphId = ?", userId, paragraphId);
}

export function isStarred(userId: string, paragraphId: string): boolean {
  return Boolean(
    get("SELECT 1 AS x FROM paragraph_stars WHERE userId = ? AND paragraphId = ?", userId, paragraphId),
  );
}

/** The subset of `ids` this reader has starred — one query for a whole history list. */
export function starredAmong(userId: string, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const holes = ids.map(() => "?").join(",");
  const rows = all<{ paragraphId: string }>(
    `SELECT paragraphId FROM paragraph_stars WHERE userId = ? AND paragraphId IN (${holes})`,
    userId,
    ...ids,
  );
  return new Set(rows.map((row) => row.paragraphId));
}

/** Whether *anyone* has kept this passage — which is what pruning must respect. */
export function starredByAnyone(paragraphId: string): boolean {
  return Boolean(get("SELECT 1 AS x FROM paragraph_stars WHERE paragraphId = ?", paragraphId));
}
