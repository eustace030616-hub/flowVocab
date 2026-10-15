/**
 * Serving and scoring the placement test.
 *
 * The item set is built server-side and kept there: a test whose pseudowords are identifiable from
 * the payload measures nothing, so the client receives opaque ids and words only.
 */

import { Word } from "../../models/Word";
import { PlacementSession } from "../../models/PlacementSession";
import type { TargetLang } from "../lang";
import {
  PSEUDOWORDS,
  REAL_WORDS,
  generatePseudowords,
  placementLevels,
  scorePlacement,
  seedFrom,
  type PlacementItem,
  type PlacementResponse,
} from "./placement";

/** Difficulty bands sampled across, so the test discriminates over the whole scale. */
const BANDS = 10;

/** Donors are drawn broadly, so the fakes share the register of the real items. */
const DONOR_POOL = 400;

async function sampleRealItems(targetLang: TargetLang, count: number): Promise<PlacementItem[]> {
  // Bands are equal-width over the *difficulty axis*, not over the word population.
  //
  // Both alternatives were tried and both failed, in opposite directions. Equal width with a fixed
  // quota per band came back with 42 real words of 67, because English difficulty clusters per CEFR
  // level and four of ten bands were empty. `$bucketAuto` fixed that and broke something worse:
  // German difficulty is so skewed — 112k words above 0.92 — that nine of its ten buckets sat above
  // 0.75, so the test held almost no easy items. A simulated learner of true ability 0.2 and one of
  // 0.4 both recovered as 0.01, the floor, because nothing in the test could distinguish them. A
  // placement test that cannot measure beginners is not a placement test.
  //
  // What identification needs is items spread evenly across the axis, so the quota goes evenly to
  // the bands that have words in them, whatever their size.
  const boundaries = [...Array.from({ length: BANDS }, (_, i) => i / BANDS), 1.0001];
  const buckets = await Word.aggregate([
    {
      $match: {
        targetLang,
        origin: "import",
        difficulty: { $gte: 0, $lt: 1.0001 },
      },
    },
    { $bucket: { groupBy: "$difficulty", boundaries, output: { n: { $sum: 1 } } } },
  ]);

  const populated = buckets.filter((bucket) => bucket.n > 0);
  if (populated.length === 0) return [];

  const quota = Math.max(1, Math.floor(count / populated.length));

  const items: PlacementItem[] = [];
  const seen = new Set<string>();

  const take = async (min: number, max: number, size: number) => {
    if (size <= 0) return;
    const rows = await Word.aggregate([
      {
        $match: {
          targetLang,
          origin: "import",
          difficulty: { $gte: min, $lt: max },
        },
      },
      { $sample: { size } },
      { $project: { lemmaKey: 1, lemma: 1, difficulty: 1 } },
    ]);
    for (const row of rows) {
      if (seen.has(row.lemmaKey)) continue;
      seen.add(row.lemmaKey);
      items.push({
        id: `r${items.length}`,
        text: row.lemma,
        isPseudoword: false,
        difficulty: row.difficulty,
      });
    }
  };

  for (const bucket of populated) {
    await take(bucket._id, bucket._id + 1 / BANDS, quota);
  }

  // Top up if a band held fewer words than its quota, so the test is always the full length. The
  // top-up widens the existing coverage rather than concentrating it: it samples the whole axis.
  if (items.length < count) {
    const rows = await Word.aggregate([
      { $match: { targetLang, origin: "import", difficulty: { $gte: 0, $lt: 1.0001 } } },
      { $sample: { size: count - items.length + 40 } },
      { $project: { lemmaKey: 1, lemma: 1, difficulty: 1 } },
    ]);
    for (const row of rows) {
      if (items.length >= count) break;
      if (seen.has(row.lemmaKey)) continue;
      seen.add(row.lemmaKey);
      items.push({
        id: `r${items.length}`,
        text: row.lemma,
        isPseudoword: false,
        difficulty: row.difficulty,
      });
    }
  }

  return items.slice(0, count);
}

/**
 * Which candidates are real words, in any form we hold.
 *
 * Checked against the lexicon rather than assumed: a "pseudoword" that happens to be a real word —
 * or an inflected form of one, which is why surface forms are checked too — would be answered yes by
 * a learner who knows it and scored as over-claiming, testing the opposite of what it is for.
 */
async function realWordSet(targetLang: TargetLang, candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await Word.find({
    targetLang,
    $or: [{ lemmaKey: { $in: candidates } }, { surfaceForms: { $in: candidates } }],
  })
    .select("lemmaKey surfaceForms")
    .lean();

  const real = new Set<string>();
  const wanted = new Set(candidates);
  for (const row of rows) {
    if (wanted.has(row.lemmaKey)) real.add(row.lemmaKey);
    for (const form of row.surfaceForms ?? []) {
      if (wanted.has(form)) real.add(form);
    }
  }
  return real;
}

/** Build a fresh test for one learner and language. */
export async function createPlacementSession(
  userId: string,
  targetLang: TargetLang,
): Promise<{ sessionId: string; items: Array<{ id: string; text: string }>; warning: string }> {
  const real = await sampleRealItems(targetLang, REAL_WORDS);

  const donors = await Word.aggregate([
    { $match: { targetLang, origin: "import", difficulty: { $gte: 0 } } },
    { $sample: { size: DONOR_POOL } },
    { $project: { lemma: 1 } },
  ]);
  const donorWords = donors.map((d) => String(d.lemma).toLowerCase()).filter((w) => w.length >= 4);

  // Generate in rounds: the generator rejects anything the lexicon knows, and a round may come back
  // short, so asking for a surplus and verifying in one query is cheaper than a query per candidate.
  let pseudowords: string[] = [];
  const accepted = new Set<string>();
  for (let round = 0; round < 8 && pseudowords.length < PSEUDOWORDS; round += 1) {
    const candidates = generatePseudowords({
      count: PSEUDOWORDS * 3,
      seed: seedFrom(`${targetLang}:${userId}:${round}`),
      donors: donorWords,
      isRealWord: (candidate) => accepted.has(candidate),
    }).filter((candidate) => !accepted.has(candidate));

    const realOnes = await realWordSet(targetLang, candidates);
    for (const candidate of candidates) {
      if (pseudowords.length >= PSEUDOWORDS) break;
      if (realOnes.has(candidate) || accepted.has(candidate)) continue;
      accepted.add(candidate);
      pseudowords.push(candidate);
    }
  }

  const items: PlacementItem[] = [
    ...real,
    ...pseudowords.map((text, index) => ({
      id: `p${index}`,
      text,
      isPseudoword: true,
    })),
  ];

  // Shuffled, so the pseudowords are not simply the tail of the list.
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }

  const session = await PlacementSession.create({
    userId,
    targetLang,
    seed: seedFrom(`${targetLang}:${userId}`),
    items,
    responses: [],
  });

  return {
    sessionId: String(session._id),
    // Deliberately without `isPseudoword` or `difficulty`: the client must not be able to tell.
    items: items.map((item) => ({ id: item.id, text: item.text })),
    warning:
      "Answer yes only if you are sure you know the word. Some of these are not real words, and claiming them lowers your result.",
  };
}

export interface PlacementSubmitResult {
  hits: number;
  falseAlarms: number;
  corrected: number;
  total: number;
  falseAlarmRate: number;
  dPrime: number;
  theta: number;
  se: number;
  level: string | null;
  levelLow: string;
  levelHigh: string;
}

/** Score a submitted test, record it, and hand the numbers back. */
export async function submitPlacement(
  userId: string,
  sessionId: string,
  responses: PlacementResponse[],
): Promise<PlacementSubmitResult | null> {
  const session = await PlacementSession.findOne({ _id: sessionId, userId });
  if (!session) return null;

  // Mongoose's inference through a subdocument array loses the shape, so the item set is read once
  // with its declared type and used for both the score and the counts.
  const items = session.items as unknown as PlacementItem[];
  const totalReal = items.filter((item) => !item.isPseudoword).length;
  if (session.completedAt) {
    // Already scored: return the stored result rather than folding the test in twice.
    const stored = session.score;
    if (stored) {
      return {
        hits: stored.hits,
        falseAlarms: stored.falseAlarms,
        corrected: stored.corrected,
        total: totalReal,
        falseAlarmRate: stored.falseAlarmRate,
        dPrime: stored.dPrime,
        theta: stored.theta,
        se: stored.se,
        level: stored.level,
        levelLow: stored.levelLow,
        levelHigh: stored.levelHigh,
      };
    }
  }

  const score = scorePlacement(items, responses);
  const levels = placementLevels(score);

  session.responses = responses;
  session.completedAt = new Date();
  session.score = {
    hits: score.hits,
    falseAlarms: score.falseAlarms,
    falseAlarmRate: score.falseAlarmRate,
    corrected: score.corrected,
    dPrime: score.dPrime,
    theta: score.estimate.theta,
    se: score.estimate.se,
    level: levels.level,
    levelLow: levels.levelLow,
    levelHigh: levels.levelHigh,
  };
  await session.save();

  return {
    hits: score.hits,
    falseAlarms: score.falseAlarms,
    corrected: score.corrected,
    total: totalReal,
    falseAlarmRate: score.falseAlarmRate,
    dPrime: score.dPrime,
    theta: score.estimate.theta,
    se: score.estimate.se,
    level: levels.level,
    levelLow: levels.levelLow,
    levelHigh: levels.levelHigh,
  };
}
