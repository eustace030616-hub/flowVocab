/**
 * Serving and scoring the placement test.
 *
 * The item set is built server-side and kept there: a test whose pseudowords are identifiable from
 * the payload measures nothing, so the client receives opaque ids and words only.
 */

import {
  difficultyBandCounts,
  glossKeys,
  realWordsMatching,
  sampleWords,
  sampleWordsBetween,
} from "../store/dictionary";
import {
  completePlacementSession,
  insertPlacementSession,
  placementSessionById,
  savePlacementProgress,
} from "../store/learner";
import { glossesByKeys } from "../store/dictionary";
import { fitAbility } from "./ability";
import { glossLangFor, type TargetLang } from "../lang";
import {
  PSEUDOWORDS,
  REAL_WORDS,
  generatePseudowords,
  placementLevels,
  placementObservations,
  scorePlacement,
  seedFrom,
  type PlacementItem,
  type PlacementResponse,
} from "./placement";

/** Difficulty bands sampled across, so the test discriminates over the whole scale. */
const BANDS = 10;

/** Donors are drawn broadly, so the fakes share the register of the real items. */
const DONOR_POOL = 400;

/**
 * How many items the reader is given at a time.
 *
 * The test has no length. This is only the length of the queue: items are served, the estimate
 * moves, and more are drawn around wherever it has moved to. A fixed test of 100 items was the
 * first design, and it is the wrong shape — the useful information is all in the first twenty
 * answers, and the rest is confirming what is already known.
 */
export const PLACEMENT_BATCH = 24;
/** Draw more when the unanswered queue falls to this. */
export const PLACEMENT_REFILL_AT = 6;
/** How many to draw. */
export const PLACEMENT_REFILL_SIZE = 12;

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
  const populated = difficultyBandCounts(targetLang, BANDS);
  if (populated.length === 0) return [];

  const quota = Math.max(1, Math.floor(count / populated.length));

  const items: PlacementItem[] = [];
  const seen = new Set<string>();

  const take = async (min: number, max: number, size: number) => {
    if (size <= 0) return;
    const rows = glossedOnly(targetLang, sampleWordsBetween(targetLang, min, max, size * 3)).slice(
      0,
      size,
    );
    for (const row of rows) {
      if (seen.has(row.lemmaKey)) continue;
      seen.add(row.lemmaKey);
      items.push({
        id: `r${items.length}`,
        text: row.lemma,
        isPseudoword: false,
        difficulty: row.difficulty,
        lemmaKey: row.lemmaKey,
      });
    }
  };

  for (const bucket of populated) {
    await take(bucket.band / BANDS, (bucket.band + 1) / BANDS, quota);
  }

  // Top up if a band held fewer words than its quota, so the test is always the full length. The
  // top-up widens the existing coverage rather than concentrating it: it samples the whole axis.
  if (items.length < count) {
    const rows = glossedOnly(targetLang, sampleWords(targetLang, (count - items.length + 40) * 3));
    for (const row of rows) {
      if (items.length >= count) break;
      if (seen.has(row.lemmaKey)) continue;
      seen.add(row.lemmaKey);
      items.push({
        id: `r${items.length}`,
        text: row.lemma,
        isPseudoword: false,
        difficulty: row.difficulty,
        lemmaKey: row.lemmaKey,
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
  const rows = realWordsMatching(targetLang, candidates);

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
/**
 * Drop the words the glossary cannot translate.
 *
 * The reveal after each answer is the payoff for admitting you do not know a word, and "No
 * translation yet" is not one — it was happening on roughly one item in twenty, the same vocabulary
 * gaps the headless check reports. Over-sampling and filtering costs one query and keeps the reveal
 * worth reading.
 */
function glossedOnly(
  targetLang: TargetLang,
  rows: Array<{ lemmaKey: string; lemma: string; difficulty: number }>,
): Array<{ lemmaKey: string; lemma: string; difficulty: number }> {
  if (rows.length === 0) return rows;
  const glossed = glossKeys(
    targetLang,
    glossLangFor(targetLang),
    rows.map((row) => row.lemmaKey),
  );
  return rows.filter((row) => glossed.has(row.lemmaKey));
}

/**
 * Non-words that are not words, checked against the lexicon.
 *
 * Generated in rounds and verified in one query per round, rather than one query per candidate: the
 * generator rejects anything the vocabulary knows, and a round may come back short.
 */
async function pseudowordItems(
  targetLang: TargetLang,
  seedKey: string,
  count: number,
  taken: Set<string> = new Set(),
): Promise<PlacementItem[]> {
  const donorWords = sampleWords(targetLang, DONOR_POOL)
    .map((row) => row.lemma.toLowerCase())
    .filter((word) => word.length >= 4);

  const accepted = new Set<string>(taken);
  const out: PlacementItem[] = [];
  for (let round = 0; round < 8 && out.length < count; round += 1) {
    const candidates = generatePseudowords({
      count: count * 3,
      seed: seedFrom(`${seedKey}:${round}`),
      donors: donorWords,
      isRealWord: (candidate) => accepted.has(candidate),
    }).filter((candidate) => !accepted.has(candidate));

    const realOnes = await realWordSet(targetLang, candidates);
    for (const candidate of candidates) {
      if (out.length >= count) break;
      if (realOnes.has(candidate) || accepted.has(candidate)) continue;
      accepted.add(candidate);
      out.push({ id: `p${out.length}-${candidate.slice(0, 4)}`, text: candidate, isPseudoword: true });
    }
  }
  return out;
}

/**
 * More real items, around where the estimate currently sits.
 *
 * This is what makes an unbounded test worth having. A fixed pool spread evenly over the whole axis
 * spends most of its items where the reader is not — an item three bands away is answered in an
 * instant and says nothing. Sampling near the estimate is where the information is, widening only
 * when the narrow window cannot fill the queue.
 */
async function sampleAround(
  targetLang: TargetLang,
  theta: number,
  count: number,
  taken: Set<string>,
): Promise<PlacementItem[]> {
  const halfBand = 1 / BANDS;
  const windows: Array<[number, number]> = [
    [theta - halfBand, theta + halfBand],
    [theta - halfBand * 2, theta + halfBand * 2],
    [theta - halfBand * 4, theta + halfBand * 4],
    [0, 1.0001],
  ];

  const items: PlacementItem[] = [];
  for (const [min, max] of windows) {
    if (items.length >= count) break;
    const rows = glossedOnly(
      targetLang,
      sampleWordsBetween(targetLang, Math.max(0, min), Math.min(1.0001, max), count * 3),
    );
    for (const row of rows) {
      if (items.length >= count) break;
      if (taken.has(row.lemmaKey)) continue;
      taken.add(row.lemmaKey);
      items.push({
        id: `r${taken.size}`,
        text: row.lemma,
        isPseudoword: false,
        difficulty: row.difficulty,
        lemmaKey: row.lemmaKey,
      });
    }
  }
  return items;
}

export async function createPlacementSession(
  userId: string,
  targetLang: TargetLang,
): Promise<{ sessionId: string; items: Array<{ id: string; text: string }> }> {
  // The opening queue is spread across the axis rather than concentrated, because nothing is known
  // yet: the *first* estimate has to be identifiable, and that needs items everywhere. Every later
  // batch is drawn around the estimate instead — see `sampleAround`.
  const real = await sampleRealItems(targetLang, PLACEMENT_BATCH);

  const pseudowords = await pseudowordItems(
    targetLang,
    `${targetLang}:${userId}:${Date.now().toString(36)}`,
    Math.round(PLACEMENT_BATCH / 3),
  );

  const items: PlacementItem[] = [...real, ...pseudowords];

  // Shuffled, so the pseudowords are not simply the tail of the list.
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }

  const sessionId = insertPlacementSession({
    userId,
    targetLang,
    seed: seedFrom(`${targetLang}:${userId}`),
    items,
  });

  return {
    sessionId,
    // Deliberately without `isPseudoword`, `difficulty` or `lemmaKey`: the client must not be able
    // to tell, and must not be able to look anything up before it has answered.
    items: items.map((item) => ({ id: item.id, text: item.text })),
  };
}

export interface PlacementSubmitResult {
  hits: number;
  falseAlarms: number;
  corrected: number;
  /** Real words *answered*, so an early exit does not read as a score out of the full test. */
  total: number;
  /** Items answered in total, and the size of the test as served. */
  answered: number;
  sessionSize: number;
  falseAlarmRate: number;
  dPrime: number;
  theta: number;
  se: number;
  level: string | null;
  levelLow: string;
  levelHigh: string;
}

/** The score as it is stored, so a replay of a completed session reads the same shape. */
interface StoredScore {
  hits: number;
  falseAlarms: number;
  falseAlarmRate: number;
  corrected: number;
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
  const session = placementSessionById(userId, sessionId);
  if (!session) return null;

  // Mongoose's inference through a subdocument array loses the shape, so the item set is read once
  // with its declared type and used for both the score and the counts.
  const items = session.items as unknown as PlacementItem[];
  const answeredIds = new Set(responses.map((entry) => entry.id));
  // Counts describe what was answered, not what was served: reporting "8/67" for a learner who
  // answered thirty items reads as a score out of the whole test.
  const answeredReal = items.filter(
    (item) => !item.isPseudoword && answeredIds.has(item.id),
  ).length;
  if (session.completedAt) {
    // Already scored: return the stored result rather than folding the test in twice. A retake
    // replaces the previous evidence instead of averaging with it, so this is a genuine replay.
    const stored = session.score as StoredScore | null;
    if (stored) {
      return {
        hits: stored.hits,
        falseAlarms: stored.falseAlarms,
        corrected: stored.corrected,
        total: answeredReal,
        answered: answeredIds.size,
        sessionSize: items.length,
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

  completePlacementSession(sessionId, responses, {
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
  } satisfies StoredScore);

  return {
    hits: score.hits,
    falseAlarms: score.falseAlarms,
    corrected: score.corrected,
    total: answeredReal,
    answered: answeredIds.size,
    sessionSize: items.length,
    falseAlarmRate: score.falseAlarmRate,
    dPrime: score.dPrime,
    theta: score.estimate.theta,
    se: score.estimate.se,
    level: levels.level,
    levelLow: levels.levelLow,
    levelHigh: levels.levelHigh,
  };
}

/**
 * ── One answer, with its reveal ───────────────────────────────────────────────────────────────
 *
 * The test is answered a word at a time and has no length, so the unit of work is one answer rather
 * than one submission. Each call does four things: records the answer, reveals what the word was,
 * moves the estimate, and tops the queue up if it is running out.
 *
 * The reveal is the point of splitting this out. A translation shown before the decision would make
 * this a reading test; shown after, it is feedback — the reader learns the word they just admitted
 * they did not know, and the test stays a test.
 */
export async function answerPlacement(
  userId: string,
  targetLang: TargetLang,
  sessionId: string,
  itemId: string,
  yes: boolean,
): Promise<{
  gloss: string | null;
  isPseudoword: boolean;
  answered: number;
  served: number;
  /** The estimate so far, so the reader can see what the test is concluding as they go. */
  estimate: { theta: number; se: number; level: string | null; levelLow: string; levelHigh: string };
  items: Array<{ id: string; text: string }>;
} | null> {
  const session = placementSessionById(userId, sessionId);
  if (!session || session.targetLang !== targetLang) return null;

  const items = session.items as unknown as PlacementItem[];
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return null;

  // Answering the same item twice replaces the answer rather than counting twice: the reader may go
  // back to a word they were unsure of, and the estimate should follow their latest decision.
  const responses = (session.responses as PlacementResponse[]).filter((entry) => entry.id !== itemId);
  responses.push({ id: itemId, yes });
  savePlacementProgress(sessionId, responses);

  // The estimate from the placement answers alone. The event log has its say when the test is
  // finished and folded in; while it is running, this is what the reader is shown.
  const estimate = fitAbility(placementObservations(items, responses), {
    theta: 0.5,
    weight: 2,
  });

  // Top the queue up when it is nearly spent, drawing around where the estimate now sits.
  const answeredIds = new Set(responses.map((entry) => entry.id));
  const remaining = items.filter((entry) => !answeredIds.has(entry.id));
  let next = items;
  let served = items.length;
  if (remaining.length <= PLACEMENT_REFILL_AT) {
    const taken = new Set(items.map((entry) => entry.lemmaKey).filter(Boolean) as string[]);
    const takenText = new Set(items.map((entry) => entry.text.toLowerCase()));
    const real = await sampleAround(targetLang, estimate.theta, PLACEMENT_REFILL_SIZE, taken);
    const fakes = (
      await pseudowordItems(
        targetLang,
        `${targetLang}:${userId}:${sessionId}:${items.length}`,
        Math.round(PLACEMENT_REFILL_SIZE / 3),
        takenText,
      )
    ).filter((entry) => !takenText.has(entry.text.toLowerCase()));
    next = [...items, ...real, ...fakes];
    served = next.length;
    savePlacementProgress(sessionId, responses, next);
  }

  // The translation, looked up only now.
  let gloss: string | null = null;
  if (!item.isPseudoword && item.lemmaKey) {
    const [best] = glossesByKeys(targetLang, glossLangFor(targetLang), [item.lemmaKey]);
    gloss = best?.text ?? null;
  }

  return {
    gloss,
    isPseudoword: item.isPseudoword,
    answered: responses.length,
    served,
    estimate: {
      theta: estimate.theta,
      se: estimate.se,
      level: estimate.level,
      levelLow: estimate.levelLow,
      levelHigh: estimate.levelHigh,
    },
    items: next
      .slice(items.length)
      .map((entry) => ({ id: entry.id, text: entry.text })),
  };
}
