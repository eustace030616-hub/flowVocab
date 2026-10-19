/**
 * The reader's own verdict on a passage's difficulty, kept beside the app's.
 *
 * Three opinions exist about every passage:
 *
 *   the app's band      from per-word knowledge probabilities — "5 words you don't know"
 *   the reader's        from having actually read it — "that was easy"
 *   the estimate        from every mark and every exposure ever made — "you are about B1"
 *
 * They are supposed to agree. When they do not, one of the three is wrong, and the disagreement is
 * the only direct evidence available about which: if a B1 reader calls a "hard" passage easy, then
 * either the band is too pessimistic, or the estimate is too low, or the difficulty of those words
 * is overstated. Recording all three at the moment of the vote is what makes that question
 * answerable later, because it preserves what the app believed *then* rather than letting a later
 * recalibration rewrite the history.
 */

import { all, get, newId, nowMs, run } from "./db";

export interface DifficultyVote {
  id: string;
  userId: string;
  targetLang: string;
  paragraphId: string;
  /** What the reader said. */
  userBand: string;
  /** What the app computed, as it was at the time. */
  computedBand: string;
  unknownCount: number;
  coverage: number;
  theta: number;
  se: number;
  n: number;
  levelPoint: string;
  levelLow: string;
  levelHigh: string;
  createdAt: number;
}

export function recordDifficultyVote(vote: Omit<DifficultyVote, "id" | "createdAt">): string {
  const id = newId();
  run(
    `INSERT INTO difficulty_votes (id, userId, targetLang, paragraphId, userBand, computedBand,
                                   unknownCount, coverage, theta, se, n, levelPoint, levelLow,
                                   levelHigh, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    vote.userId,
    vote.targetLang,
    vote.paragraphId,
    vote.userBand,
    vote.computedBand,
    vote.unknownCount,
    vote.coverage,
    vote.theta,
    vote.se,
    vote.n,
    vote.levelPoint,
    vote.levelLow,
    vote.levelHigh,
    nowMs(),
  );
  return id;
}

export function recentVotes(userId: string, limit = 50): DifficultyVote[] {
  return all<DifficultyVote>(
    "SELECT * FROM difficulty_votes WHERE userId = ? ORDER BY createdAt DESC LIMIT ?",
    userId,
    limit,
  );
}

/** The reader's verdict for one passage, if they have given one. */
export function voteForParagraph(userId: string, paragraphId: string): string | null {
  const row = get<{ userBand: string }>(
    "SELECT userBand FROM difficulty_votes WHERE userId = ? AND paragraphId = ? ORDER BY createdAt DESC LIMIT 1",
    userId,
    paragraphId,
  );
  return row?.userBand ?? null;
}

export interface CalibrationSummary {
  votes: number;
  /** How often the reader agreed with the computed band. */
  agreement: number;
  /** Agreement broken down by what the app said, which is where a systematic bias shows. */
  byComputed: Array<{ computedBand: string; votes: number; agreed: number }>;
  /** And broken down by the reader's answer, which is where an optimistic reader shows. */
  byUser: Array<{ userBand: string; votes: number }>;
  /** Mean ability at the time of the votes, so disagreements can be read against it. */
  meanTheta: number;
}

export function calibrationSummary(userId: string): CalibrationSummary {
  const rows = recentVotes(userId, 500);
  const byComputed = new Map<string, { votes: number; agreed: number }>();
  const byUser = new Map<string, number>();
  let agreed = 0;
  let thetaSum = 0;

  for (const row of rows) {
    const same = row.userBand === row.computedBand;
    if (same) agreed += 1;
    thetaSum += row.theta;
    const bucket = byComputed.get(row.computedBand) ?? { votes: 0, agreed: 0 };
    bucket.votes += 1;
    if (same) bucket.agreed += 1;
    byComputed.set(row.computedBand, bucket);
    byUser.set(row.userBand, (byUser.get(row.userBand) ?? 0) + 1);
  }

  return {
    votes: rows.length,
    agreement: rows.length === 0 ? 0 : agreed / rows.length,
    byComputed: [...byComputed.entries()].map(([computedBand, value]) => ({ computedBand, ...value })),
    byUser: [...byUser.entries()].map(([userBand, votes]) => ({ userBand, votes })),
    meanTheta: rows.length === 0 ? 0 : thetaSum / rows.length,
  };
}
