/**
 * Derived learner state, folded from the append-only Event log.
 *
 * `Word.status/timesMet/unfamiliarity` are a *cache*. The log is the truth. Two rules follow
 * from that, and they are the whole point of this module:
 *
 *   1. Derivation is a pure fold over events. Recompute it any time and you get the same
 *      answer — so a counter that drifts (a double-click bug, a partial write, a bad
 *      migration) is repairable rather than permanent.
 *
 *   2. Un-marking still floors the counter at zero, exactly as before, but it no longer
 *      *destroys evidence*: the `mark` event stays in the log, so the history survives and
 *      the ability model can see that the learner marked this word and then changed their
 *      mind. Previously that was unrecoverable.
 *
 * What is genuinely new in Phase 0 is the two signals that were never recorded at all:
 * `exposure` (the word was on screen and the learner did not click it — the cheapest and
 * strongest evidence of knowing a word) and `lookup` (checked, but not marked).
 */

import { Event, type EventSource, type EventType, type EventItem } from "../../models/Event";
import { Word, type WordStatus } from "../../models/Word";
import type { TargetLang } from "../lang";
import mongoose from "mongoose";

export interface SignalCounts {
  marks: number;
  unmarks: number;
  lookups: number;
  exposures: number;
  confirmed: number;
  notSure: number;
}

export interface DerivedState extends SignalCounts {
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;
  status: WordStatus;
}

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
 * Recompute one word's cached state from the log and persist it.
 *
 * Single-item events carry `lemmaKey` directly. Batched `exposure` events carry an `items`
 * array, so exposures are counted with a `$elemMatch`-style query rather than being unfolded.
 */
export async function recomputeWordState(
  userId: mongoose.Types.ObjectId | string,
  targetLang: TargetLang,
  lemmaKey: string,
  wordId?: mongoose.Types.ObjectId | string,
): Promise<DerivedState> {
  const single = await Event.find({ userId, targetLang, lemmaKey }).select("type").lean();
  const counts = countsFromEvents(single);

  const exposureEvents = await Event.countDocuments({
    userId,
    targetLang,
    type: "exposure",
    "items.lemmaKey": lemmaKey,
  });
  counts.exposures += exposureEvents;

  const state = deriveState(counts);

  await Word.updateOne(
    wordId ? { _id: wordId } : { targetLang, lemmaKey },
    {
      $set: {
        timesMet: state.timesMet,
        unfamiliarity: state.unfamiliarity,
        lookupCount: state.lookupCount,
        exposureCount: state.exposureCount,
        status: state.status,
      },
    },
  );

  return state;
}

export interface AppendEventArgs {
  userId: mongoose.Types.ObjectId | string;
  targetLang: TargetLang;
  type: EventType;
  source?: EventSource;
  sessionId?: string;
  paragraphId?: mongoose.Types.ObjectId | string;
  wordId?: mongoose.Types.ObjectId | string;
  surface?: string;
  lemmaKey?: string;
  charStart?: number;
  charEnd?: number;
  items?: EventItem[];
}

/** Append one event. There is deliberately no update or delete counterpart. */
export async function appendEvent(args: AppendEventArgs) {
  return Event.create({ ...args, ts: new Date() });
}

/**
 * Append an exposure batch: every item that was on screen in one paragraph view.
 *
 * One insert per paragraph view rather than one per word, because a 60-token paragraph
 * would otherwise cost 60 writes on every page turn — and exposures are the highest-volume
 * signal by far.
 */
export async function appendExposureBatch(args: {
  userId: mongoose.Types.ObjectId | string;
  targetLang: TargetLang;
  paragraphId: mongoose.Types.ObjectId | string;
  sessionId?: string;
  items: EventItem[];
  source?: EventSource;
}) {
  if (args.items.length === 0) return null;
  return Event.create({
    userId: args.userId,
    targetLang: args.targetLang,
    type: "exposure",
    source: args.source ?? "web",
    sessionId: args.sessionId,
    paragraphId: args.paragraphId,
    items: args.items,
    ts: new Date(),
  });
}
