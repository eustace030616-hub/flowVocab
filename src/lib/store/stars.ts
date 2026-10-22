/**
 * Stars, per reader.
 *
 * A star is an opinion about a passage — "keep this one" — so it belongs to the reader who holds it.
 * It was a column on the passage until two accounts existed and the isolation test found one person's
 * star on the other's copy.
 *
 * No driver is imported here: the caller supplies one, which is what lets the same functions run on
 * the SQLite file and on D1.
 */
import type { StoreDriver } from "./driver";
import { nowMs } from "./util";

export async function setStar(
  userId: string,
  paragraphId: string,
  starred: boolean,
  store: StoreDriver,
): Promise<void> {
  if (starred) {
    await store.run(
      "INSERT INTO paragraph_stars (userId, paragraphId, createdAt) VALUES (?,?,?) ON CONFLICT DO NOTHING",
      userId,
      paragraphId,
      nowMs(),
    );
    return;
  }
  await store.run("DELETE FROM paragraph_stars WHERE userId = ? AND paragraphId = ?", userId, paragraphId);
}

export async function isStarred(
  userId: string,
  paragraphId: string,
  store: StoreDriver,
): Promise<boolean> {
  const row = await store.get<{ x: number }>(
    "SELECT 1 AS x FROM paragraph_stars WHERE userId = ? AND paragraphId = ?",
    userId,
    paragraphId,
  );
  return Boolean(row);
}

/** The subset of `ids` this reader has starred — one query for a whole history list. */
export async function starredAmong(
  userId: string,
  ids: readonly string[],
  store: StoreDriver,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const holes = ids.map(() => "?").join(",");
  const rows = await store.all<{ paragraphId: string }>(
    `SELECT paragraphId FROM paragraph_stars WHERE userId = ? AND paragraphId IN (${holes})`,
    userId,
    ...ids,
  );
  return new Set(rows.map((row) => row.paragraphId));
}

/** Whether *anyone* has kept this passage — which is what pruning must respect. */
export async function starredByAnyone(paragraphId: string, store: StoreDriver): Promise<boolean> {
  return Boolean(
    await store.get("SELECT 1 AS x FROM paragraph_stars WHERE paragraphId = ?", paragraphId),
  );
}
