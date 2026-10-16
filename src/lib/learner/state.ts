/**
 * Derived learner state, folded from the append-only Event log.
 *
 * `WordState` is a *cache*. The log is the truth. Three rules follow, and they are the whole
 * point of this module:
 *
 *   1. Derivation is a pure fold over events. Recompute it any time and you get the same
 *      answer — so a counter that drifts (a double-click bug, a partial write, a bad
 *      migration) is repairable rather than permanent.
 *
 *   2. Un-marking still floors the counter at zero, but it no longer *destroys evidence*: the
 *      `mark` event stays in the log, so the history survives and the ability model can see
 *      that the learner marked this word and then changed their mind.
 *
 *   3. State is per *(learner, language, item)* and lives in `WordState`, never on the shared
 *      `Word` document. A vocabulary entry is reference data every learner shares; mixing one
 *      learner's history into it makes two learners overwrite each other.
 *
 * What is genuinely new in Phase 0 is the two signals that were never recorded at all:
 * `exposure` (the word was on screen and the learner did not click it — the cheapest and
 * strongest evidence of knowing a word) and `lookup` (checked, but not marked).
 */

import { Event, type EventSource, type EventType, type EventItem } from "../../models/Event";
type IEvent = InstanceType<typeof Event>;
import { type WordStatus } from "../../models/WordState";
import {
  countEvents,
  countExposureItems,
  insertEvent,
  upsertWordState,
  wordStatesFor,
  eventsFor,
} from "../store/learner";
import { wordsByLemma } from "../store/dictionary";
import type { TargetLang } from "../lang";

export type { WordStatus } from "../../models/WordState";

export interface SignalCounts {
  marks: number;
  unmarks: number;
  lookups: number;
  exposures: number;
  confirmed: number;
  notSure: number;
}

/** The part of the state that is persisted per learner. Deliberately excludes the raw signal
 *  counts (marks/unmarks/…): WordState is a summary, and reporting `marks: 0` from it would be
 *  a lie — those counts only exist in the event log. */
export interface WordStateSummary {
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;
  status: WordStatus;
}

/** The full fold result, including the signal counts it was derived from. */
export interface DerivedState extends SignalCounts, WordStateSummary {}

export const EMPTY_COUNTS: SignalCounts = {
  marks: 0,
  unmarks: 0,
  lookups: 0,
  exposures: 0,
  confirmed: 0,
  notSure: 0,
};

/**
 * The fold. Pure and order-independent: only the multiset of events matters, never their
 * sequence. (Order will matter once forgetting/decay is modelled in Phase 2; that change
 * belongs here and nowhere else.)
 */
export function deriveState(counts: SignalCounts): DerivedState {
  const timesMet = counts.marks;
  const unfamiliarity = Math.max(0, counts.marks - counts.unmarks);

  return {
    ...counts,
    timesMet,
    unfamiliarity,
    lookupCount: counts.lookups,
    exposureCount: counts.exposures,
    status: statusFor(timesMet, unfamiliarity),
  };
}

/**
 * `learning` used to be a dead enum value that nothing ever assigned. It now means what it
 * says: met repeatedly, still unfamiliar.
 */
export function statusFor(timesMet: number, unfamiliarity: number): WordStatus {
  if (timesMet === 0) return "unfamiliar";
  if (unfamiliarity === 0) return "known";
  if (timesMet >= 3) return "learning";
  return "unfamiliar";
}

export function countsFromEvents(
  events: Array<Pick<import("../../models/Event").IEvent, "type">>,
): SignalCounts {
  const counts: SignalCounts = { ...EMPTY_COUNTS };
  for (const e of events) {
    switch (e.type) {
      case "mark":
        counts.marks += 1;
        break;
      case "unmark":
        counts.unmarks += 1;
        break;
      case "lookup":
        counts.lookups += 1;
        break;
      case "exposure":
        counts.exposures += 1;
        break;
      case "confirmed":
        counts.confirmed += 1;
        break;
      case "not_sure":
        counts.notSure += 1;
        break;
    }
  }
  return counts;
}

/**
 * Recompute one learner's state for one item from the log, and persist the cache.
 *
 * Single-item events carry `lemmaKey` directly. Batched `exposure` events carry an `items`
 * array, so exposures are counted with a query rather than being unfolded.
 */
export async function recomputeWordState(
  userId: string,
  targetLang: TargetLang,
  lemmaKey: string,
  wordId?: string,
): Promise<DerivedState> {
  // Exposures arrive batched, one row per paragraph view with an `items` array, so they are counted
  // rather than unfolded — the log is the same, the read is cheaper.
  const single = eventsFor(userId, targetLang, 0, 100_000).filter((e) => e.lemmaKey === lemmaKey);
  const counts = countsFromEvents(single as unknown as Array<Pick<IEvent, "type">>);

  counts.exposures += countExposureItems(userId, targetLang, lemmaKey);

  const state = deriveState(counts);

  // Attach to the shared vocabulary entry, so a state row can be joined to a gloss.
  const resolvedWordId = wordId ?? wordsByLemma(targetLang, lemmaKey)[0]?._id;

  if (resolvedWordId) {
    upsertWordState(userId, targetLang, {
      wordId: resolvedWordId,
      lemmaKey,
      status: state.status,
      timesMet: state.timesMet,
      unfamiliarity: state.unfamiliarity,
      lookupCount: state.lookupCount,
      exposureCount: state.exposureCount,
    });
  }

  return state;
}

/** One learner's state for a set of items, keyed by lemmaKey. Absent means "never met". */
export async function statesFor(
  userId: string,
  targetLang: TargetLang,
  lemmaKeys: string[],
): Promise<Map<string, WordStateSummary>> {
  const map = new Map<string, WordStateSummary>();
  if (lemmaKeys.length === 0) return map;

  for (const [lemmaKey, row] of wordStatesFor(userId, targetLang, lemmaKeys)) {
    map.set(lemmaKey, {
      timesMet: row.timesMet,
      unfamiliarity: row.unfamiliarity,
      lookupCount: row.lookupCount,
      exposureCount: row.exposureCount,
      status: row.status as WordStatus,
    });
  }
  return map;
}

export interface AppendEventArgs {
  userId: string;
  targetLang: TargetLang;
  type: EventType;
  source?: EventSource;
  sessionId?: string;
  paragraphId?: string;
  wordId?: string;
  surface?: string;
  lemmaKey?: string;
  charStart?: number;
  charEnd?: number;
  items?: EventItem[];
}

/** Append one event. There is deliberately no update or delete counterpart. */
export async function appendEvent(args: AppendEventArgs) {
  return insertEvent({
    userId: args.userId,
    targetLang: args.targetLang,
    type: args.type,
    source: args.source,
    sessionId: args.sessionId,
    paragraphId: args.paragraphId,
    wordId: args.wordId,
    surface: args.surface,
    lemmaKey: args.lemmaKey,
    charStart: args.charStart,
    charEnd: args.charEnd,
    items: args.items as Array<{ lemmaKey: string }> | undefined,
  });
}

/**
 * Append an exposure batch: every item that was on screen in one paragraph view.
 *
 * One insert per paragraph view rather than one per word, because a 60-token paragraph
 * would otherwise cost 60 writes on every page turn — and exposures are the highest-volume
 * signal by far.
 */
export async function appendExposureBatch(args: {
  userId: string;
  targetLang: TargetLang;
  paragraphId: string;
  sessionId?: string;
  items: EventItem[];
  source?: EventSource;
}) {
  if (args.items.length === 0) return null;
  return insertEvent({
    userId: args.userId,
    targetLang: args.targetLang,
    type: "exposure",
    source: args.source ?? "web",
    sessionId: args.sessionId,
    paragraphId: args.paragraphId,
    items: args.items as Array<{ lemmaKey: string }>,
  });
}
