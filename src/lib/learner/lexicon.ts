/**
 * Building a lemma lexicon for tokenization.
 *
 * Lemmatisation is only as good as the lexicon behind it — rules alone turn "gelesen" into a
 * guess. But the client cannot hold a 281,207-lemma German lexicon, so tokenization happens on
 * the **server** and the client renders the spans it is given.
 *
 * That is a correctness decision, not just a performance one: if the client lemmatised
 * independently, the span it rendered and the lemma the server recorded could disagree, and a
 * learner's mark would attach to a word they did not click.
 *
 * ## Why this is a loop rather than one query
 *
 * The obvious implementation — collect `candidatesFor(surface)` for every word in the text, ask
 * the database about those, then tokenize — is wrong, and wrong in exactly the place that
 * matters. A compound's *parts* are not candidates of the compound ("Wortschatzaufbau" never
 * generates "wortschatz"), and a separable verb's infinitive is not a candidate of the finite
 * form ("steht" generates "stehen", never "aufstehen"). So the two features that justify the
 * whole span-based model silently stopped working server-side, while unit tests that were handed
 * a ready-made lexicon passed.
 *
 * Instead we let the tokenizer tell us what it needs: run it with a recording lookup, ask the
 * database about precisely the candidates it asked for, and repeat until it stops asking for
 * anything new. The candidate set is then exact — no guessing, no combinatorial blow-up.
 */

import type { Types } from "mongoose";

import { Word } from "../../models/Word";
import type { TargetLang } from "../lang";
import { tokenize, wordSpans, type LemmaLookup, type Span } from "../tokenize";

/** Answers which of the given lemma keys exist. Backed by the database, or by a Map in tests. */
export type LexiconQuery = (candidates: string[]) => Promise<Set<string>>;

/**
 * Tokenize against an arbitrary lexicon query.
 *
 * Pure with respect to storage, so the convergence behaviour can be tested with an in-memory
 * lexicon instead of a database. Passes are bounded; in practice two suffice.
 */
export async function tokenizeAgainst(
  text: string,
  targetLang: TargetLang,
  query: LexiconQuery,
  maxPasses = 3,
): Promise<Span[]> {
  const known = new Set<string>();
  let spans: Span[] = [];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const missed = new Set<string>();
    spans = tokenize(text, targetLang, {
      lookup: (candidate: string) => {
        if (known.has(candidate)) return true;
        missed.add(candidate);
        return false;
      },
    });

    // Nothing new was requested, so another pass would produce identical spans.
    if (missed.size === 0) return spans;

    const found = await query([...missed]);
    for (const key of found) known.add(key);
  }

  // Final pass so the returned spans reflect everything learned.
  return tokenize(text, targetLang, { lookup: (candidate) => known.has(candidate) });
}

/** The database-backed query: one `$in` per pass over exactly the candidates that were asked for. */
export function datastoreQuery(targetLang: TargetLang): LexiconQuery {
  return async (candidates) => {
    if (candidates.length === 0) return new Set();
    const found = await Word.find({
      targetLang,
      lemmaKey: { $in: candidates },
      // Dataset entries only. A word the learner marked is created on the spot, and letting those
      // in would make any marked word look like a dictionary headword to the tokenizer.
      origin: "import",
    })
      .select("lemmaKey")
      .lean();
    return new Set(found.map((w) => w.lemmaKey));
  };
}

/**
 * Tokenize a text against the database lexicon.
 *
 * Spans carry `matched`, which records whether a lexicon confirmed the lemma. Callers must treat
 * an unmatched lemma as a best-effort guess rather than ground truth.
 */
export async function tokenizeWithLexicon(
  text: string,
  targetLang: TargetLang,
): Promise<Span[]> {
  return tokenizeAgainst(text, targetLang, datastoreQuery(targetLang));
}

export interface LexiconEntry {
  _id: Types.ObjectId;
  lemma: string;
  lemmaKey: string;
}

/** Resolve the Word documents behind a set of spans, keyed by lemmaKey (first match wins). */
export async function wordsForSpans(
  targetLang: TargetLang,
  spans: Span[],
): Promise<Map<string, LexiconEntry>> {
  const keys = [...new Set(wordSpans(spans).map((s) => s.lemmaKey))];
  if (keys.length === 0) return new Map();

  const docs = await Word.find({ targetLang, lemmaKey: { $in: keys } })
    .select("_id lemma lemmaKey")
    .lean();

  const map = new Map<string, LexiconEntry>();
  for (const doc of docs) {
    if (!map.has(doc.lemmaKey)) {
      map.set(doc.lemmaKey, {
        _id: doc._id,
        lemma: doc.lemma,
        lemmaKey: doc.lemmaKey,
      });
    }
  }
  return map;
}
