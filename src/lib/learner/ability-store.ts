/**
 * The one part of `ability.ts` that reads the database.
 *
 * Split out so the rest of that module stays pure: it is imported by the reader's client bundle and by
 * the tests, and making `fitAbility` asynchronous because a sibling query needed a driver would be a
 * refactor of things that have nothing to do with storage.
 */
import { EVIDENCE_WINDOW_MS, MAX_EVENTS_FOLDED } from "./known";
import type { CefrLevel } from "../lang";
import { eventsFor } from "../store/learner";
import { wordsByKeys } from "../store/dictionary";
import { headSuffixCandidates, observationFor, type Observation, type WordEvidence } from "./ability";

export async function observationsFor(
  userId: string,
  targetLang: string,
): Promise<Observation[]> {
  // The same time bound as the read path, for the same reason: evidence beyond four half-lives is
  // 6% of its weight, and reading it made the estimate cost grow with the whole history.
  const events = eventsFor(userId, targetLang, Date.now() - EVIDENCE_WINDOW_MS, MAX_EVENTS_FOLDED);

  const perWord = new Map<string, WordEvidence>();
  /** Sessions in which each word has been on screen, so repeats within one sitting collapse. */
  const sessions = new Map<string, Set<string>>();

  const bump = (lemmaKey: string, field: keyof WordEvidence) => {
    const entry =
      perWord.get(lemmaKey) ??
      { exposures: 0, lookups: 0, marks: 0, unmarks: 0, confirmed: 0, notSure: 0 };
    entry[field] += 1;
    perWord.set(lemmaKey, entry);
  };

  for (const event of events) {
    if (event.type === "exposure") {
      // One session key per event: the recorded session, or the calendar day when a client did not
      // send one. A batch covers many words and says the same thing about each of them.
      const session =
        event.sessionId ||
        `day:${new Date(event.ts ?? Date.now()).toISOString().slice(0, 10)}`;

      for (const item of event.items ?? []) {
        const seen = sessions.get(item.lemmaKey) ?? new Set<string>();
        seen.add(session);
        sessions.set(item.lemmaKey, seen);
        // Ensure the word has an entry even before its first counted session.
        bump(item.lemmaKey, "exposures");
      }
      continue;
    }
    if (!event.lemmaKey) continue;
    switch (event.type) {
      case "lookup":
        bump(event.lemmaKey, "lookups");
        break;
      case "mark":
        bump(event.lemmaKey, "marks");
        break;
      case "unmark":
        bump(event.lemmaKey, "unmarks");
        break;
      case "confirmed":
        bump(event.lemmaKey, "confirmed");
        break;
      case "not_sure":
        bump(event.lemmaKey, "notSure");
        break;
    }
  }

  if (perWord.size === 0) return [];

  const words = wordsByKeys(targetLang, [...perWord.keys()], { origin: "import" });

  // Several entries can share a lemma key across parts of speech; the easiest reading is the one
  // the learner could have known, so take the lowest difficulty.
  const difficultyOf = new Map<string, number>();
  for (const word of words) {
    const current = difficultyOf.get(word.lemmaKey);
    if (current === undefined || word.difficulty < current) {
      difficultyOf.set(word.lemmaKey, word.difficulty);
    }
  }

  // Replace occurrence counts with distinct-session counts before scoring.
  for (const [lemmaKey, seen] of sessions) {
    const entry = perWord.get(lemmaKey);
    if (entry) entry.exposures = seen.size;
  }

  // Words with no entry of their own — compounds, mostly — inherit the difficulty of their head, so
  // that marking one is evidence rather than silence.
  const unresolved = [...perWord.keys()].filter((key) => !difficultyOf.has(key));
  if (unresolved.length > 0) {
    const candidatesFor = new Map(unresolved.map((key) => [key, headSuffixCandidates(key)]));
    const wanted = new Set<string>();
    for (const list of candidatesFor.values()) for (const head of list) wanted.add(head);

    const heads = wordsByKeys(targetLang, [...wanted], { origin: "import" });
    const headDifficulty = new Map(heads.map((w) => [w.lemmaKey, w.difficulty]));

    for (const [key, list] of candidatesFor) {
      for (const head of list) {
        const difficulty = headDifficulty.get(head);
        if (difficulty !== undefined && difficulty >= 0) {
          difficultyOf.set(key, difficulty);
          break;
        }
      }
    }
  }

  const observations: Observation[] = [];
  for (const [lemmaKey, evidence] of perWord) {
    const difficulty = difficultyOf.get(lemmaKey);
    if (difficulty === undefined || difficulty < 0) continue;
    const observation = observationFor(evidence, difficulty);
    if (observation) observations.push(observation);
  }
  return observations;
}
