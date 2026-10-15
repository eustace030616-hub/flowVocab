/**
 * Per-word knowledge probability, `pKnown`, folded from the event log.
 *
 * ## What this replaces
 *
 * The previous model decided a word was known from counters: `mastered` was
 * `unfamiliarity === 0 && timesMet > 0`, a boolean that could not fall, and `POST /words/ignore`
 * decremented a counter that a later click could flip back. Nothing decayed, so a word learned once
 * and never seen again stayed "known" forever.
 *
 * `pKnown` is a probability instead, and it combines two things that answer different questions:
 *
 *   the model     `probabilityKnown(θ, difficulty)` — what this learner's ability predicts for a
 *                 word of this difficulty. Available for every word in the lexicon, immediately,
 *                 with no history at all. This is what makes a first reading of a new text
 *                 estimable rather than a blank.
 *
 *   the evidence  what actually happened with *this* word — met it three times and never looked it
 *                 up, or looked it up twice this week.
 *
 * They are combined as a Beta-Bernoulli posterior: the model's prediction is the prior mean, and
 * the word's own evidence moves it. Word-specific evidence wins as it accumulates, and a word with
 * no history sits at the model's prediction rather than at a default of "unknown".
 *
 * ## Decay
 *
 * Evidence is weighted by age, so a word the learner demonstrated two years ago counts for much
 * less than one they met last week, and `pKnown` can fall without anything being deleted. The log
 * stays append-only; only the reading of it has a half-life.
 *
 * Pure over plain event rows, so it is testable without a database and recomputable at any time.
 */

import { probabilityKnown, EVIDENCE_WEIGHT, SESSIONS_FOR_KNOWN } from "./ability";

/** Age at which evidence counts half as much. Roughly a school term. */
export const RECENCY_HALF_LIFE_DAYS = 90;

/**
 * How far back the fold reads, in half-lives.
 *
 * Four half-lives is ~360 days, by which point evidence carries 6% of its original weight — it is
 * already invisible in the result. Reading the whole log instead made every page load do work
 * proportional to the learner's entire history: 54 events today, and ~100,000 a year at ten
 * paragraphs a day. The bound keeps the fold flat as the log grows.
 */
export const EVIDENCE_WINDOW_HALF_LIVES = 4;

/** The window as a duration, for the query that implements it. */
export const EVIDENCE_WINDOW_MS =
  RECENCY_HALF_LIFE_DAYS * EVIDENCE_WINDOW_HALF_LIVES * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on events folded in one read.
 *
 * A backstop, not the mechanism: the time window is what normally bounds the work. This exists so
 * that a pathological log — an import, a client looping on a bad render — degrades the estimate
 * gracefully instead of hanging a page load. Reaching it is logged rather than hidden.
 */
export const MAX_EVENTS_FOLDED = 20_000;

/**
 * Weight of the model's prediction, in evidence units.
 *
 * Set so that it takes real word-specific history to overturn the model: one lookup should not
 * declare a learner ignorant of a word their ability says they know, and one exposure should not
 * declare them fluent in a word it says they do not.
 */
export const MODEL_PRIOR_STRENGTH = 1;

/** Most exposure credit one word can earn from repetition, in evidence units. */
const EXPOSURE_CREDIT_MAX = 2;

export interface EventLike {
  type: string;
  lemmaKey?: string | null;
  items?: Array<{ lemmaKey: string }> | null;
  sessionId?: string | null;
  ts?: Date | string | number | null;
}

export interface FoldedWord {
  /** Distinct sessions the word was on screen in. */
  sessions: number;
  lookups: number;
  marks: number;
  confirmed: number;
  notSure: number;
  /** Recency-weighted positive evidence. */
  positive: number;
  /** Recency-weighted negative evidence. */
  negative: number;
}

/** Exponential decay on a half-life, so old evidence fades rather than being discarded. */
export function decayFactor(ageMs: number, halfLifeDays = RECENCY_HALF_LIFE_DAYS): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const halfLives = ageMs / (halfLifeDays * 24 * 60 * 60 * 1000);
  return Math.pow(0.5, halfLives);
}

function timeOf(event: EventLike): number {
  const ts = event.ts;
  if (!ts) return Date.now();
  const value = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  return Number.isFinite(value) ? value : Date.now();
}

/** One session key per event: the recorded session, or the calendar day when a client sent none. */
function sessionKeyOf(event: EventLike): string {
  if (event.sessionId) return event.sessionId;
  return `day:${new Date(timeOf(event)).toISOString().slice(0, 10)}`;
}

/**
 * Fold events into per-word evidence.
 *
 * Counts are kept alongside the weighted sums because the two consumers want different things: the
 * ability fit uses counts (ability is a trait, and recency matters less there), while `pKnown` uses
 * the decayed weights (whether a word is known *now* is exactly a recency question).
 */
export function foldWordEvidence(
  events: EventLike[],
  now = Date.now(),
): Map<string, FoldedWord> {
  const words = new Map<string, FoldedWord>();
  /** Session key → the most recent time the word was on screen in that session. */
  const seenSessions = new Map<string, Map<string, number>>();

  const entryFor = (lemmaKey: string): FoldedWord => {
    let entry = words.get(lemmaKey);
    if (!entry) {
      entry = {
        sessions: 0,
        lookups: 0,
        marks: 0,
        confirmed: 0,
        notSure: 0,
        positive: 0,
        negative: 0,
      };
      words.set(lemmaKey, entry);
    }
    return entry;
  };

  for (const event of events) {
    const age = Math.max(0, now - timeOf(event));
    const decay = decayFactor(age);

    if (event.type === "exposure") {
      const session = sessionKeyOf(event);
      for (const item of event.items ?? []) {
        const entry = entryFor(item.lemmaKey);
        const sessions = seenSessions.get(item.lemmaKey) ?? new Map<string, number>();
        const previous = sessions.get(session);
        if (previous === undefined || age < previous) sessions.set(session, age);
        seenSessions.set(item.lemmaKey, sessions);
      }
      continue;
    }

    if (!event.lemmaKey) continue;
    const entry = entryFor(event.lemmaKey);

    switch (event.type) {
      case "lookup":
        entry.lookups += 1;
        entry.negative += EVIDENCE_WEIGHT.lookup * decay;
        break;
      case "mark":
        entry.marks += 1;
        entry.negative += EVIDENCE_WEIGHT.mark * decay;
        break;
      case "unmark":
        // Retracting a mark removes that claim rather than adding a new one.
        entry.marks = Math.max(0, entry.marks - 1);
        entry.negative = Math.max(0, entry.negative - EVIDENCE_WEIGHT.mark * decay);
        break;
      case "confirmed":
        entry.confirmed += 1;
        entry.positive += EVIDENCE_WEIGHT.confirmed * decay;
        break;
      case "not_sure":
        entry.notSure += 1;
        entry.positive += EVIDENCE_WEIGHT.notSure * decay;
        break;
    }
  }

  for (const [lemmaKey, sessions] of seenSessions) {
    const entry = entryFor(lemmaKey);
    entry.sessions = sessions.size;
    if (sessions.size < SESSIONS_FOR_KNOWN) continue;

    // Credit repeat meetings, with sharply diminishing force, decayed by the most recent time the
    // word was actually on screen.
    const credit = Math.min(EXPOSURE_CREDIT_MAX, sessions.size - SESSIONS_FOR_KNOWN + 1);
    const freshest = Math.min(...sessions.values());
    entry.positive += credit * EVIDENCE_WEIGHT.exposure * decayFactor(Math.max(0, freshest));
  }

  return words;
}

export interface KnownOptions {
  /** Prior strength, in evidence units. */
  priorStrength?: number;
}

/**
 * Probability the learner knows one word.
 *
 * A Beta-Bernoulli posterior whose prior mean is the ability model's prediction:
 *
 *     pKnown = (κ·pModel + positive) / (κ + positive + negative)
 *
 * With no evidence this is exactly `pModel`; with enough of it the word's own history decides.
 */
export function pKnownFor(
  word: Pick<FoldedWord, "positive" | "negative"> | undefined,
  pModel: number,
  options: KnownOptions = {},
): number {
  const kappa = options.priorStrength ?? MODEL_PRIOR_STRENGTH;
  const positive = word?.positive ?? 0;
  const negative = word?.negative ?? 0;
  const denominator = kappa + positive + negative;
  if (denominator <= 0) return pModel;
  return (kappa * pModel + positive) / denominator;
}

/** The model's prediction for a word, from ability and difficulty alone. */
export function modelPrediction(theta: number, difficulty: number): number {
  return probabilityKnown(theta, difficulty);
}
