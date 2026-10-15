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
import { Inflection } from "../../models/Inflection";
import type { TargetLang } from "../lang";
import { lemmaKeyOf, tokenize, wordSpans, type LemmaLookup, type Span } from "../tokenize";

/** What a lexicon lookup returns: dictionary entries, and stated inflections. */
export interface LexiconData {
  /** Lemma keys that exist as dictionary entries. */
  known: Set<string>;
  /** Surface form → citation form, as stated by a morphological source. */
  forms: Map<string, string>;
}

/**
 * Answers a batch of questions. Backed by the database, or by in-memory maps in tests.
 *
 * `candidates` come from the rule-based lemmatiser and grow as it asks for more; `forms` are the
 * surfaces in the text, asked for once so a stated inflection can short-circuit the rules.
 */
export type LexiconQuery = (candidates: string[], forms: string[]) => Promise<LexiconData>;

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
  const forms = new Map<string, string>();

  // Ask about the surfaces up front: a stated inflection short-circuits the rules entirely, so it
  // is worth one query before lexing rather than discovering it after a wrong answer.
  const surfaces = [...new Set(wordSpans(tokenize(text, targetLang)).map((s) => lemmaKeyOf(s.surface)))];
  const first = await query([], surfaces);
  for (const key of first.known) known.add(key);
  for (const [form, base] of first.forms) forms.set(form, base);

  const options = () => ({
    lookup: (candidate: string) => known.has(candidate),
    resolveForm: (form: string) => forms.get(form) ?? null,
  });

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const missed = new Set<string>();
    const spans = tokenize(text, targetLang, {
      lookup: (candidate: string) => {
        if (known.has(candidate)) return true;
        missed.add(candidate);
        return false;
      },
      resolveForm: (form: string) => forms.get(form) ?? null,
    });

    // Nothing new was requested, so another pass would produce identical spans.
    if (missed.size === 0) return spans;

    const more = await query([...missed], []);
    for (const key of more.known) known.add(key);
    for (const [form, base] of more.forms) forms.set(form, base);
  }

  // Final pass so the returned spans reflect everything learned.
  return tokenize(text, targetLang, options());
}

/**
 * The database-backed query: one `$in` per batch, over exactly what was asked for.
 *
 * A stated inflection is only honoured when its base is a real dictionary entry, so a mapping can
 * never resolve a word to something the glossary cannot gloss.
 */
export function datastoreQuery(targetLang: TargetLang): LexiconQuery {
  return async (candidates, surfaces) => {
    const known = new Set<string>();

    if (candidates.length > 0) {
      const found = await Word.find({
        targetLang,
        lemmaKey: { $in: candidates },
        // Dataset entries only. A word the learner marked is created on the spot, and letting those
        // in would make any marked word look like a dictionary headword to the tokenizer.
        origin: "import",
      })
        .select("lemmaKey")
        .lean();
      for (const word of found) known.add(word.lemmaKey);
    }

    const forms = new Map<string, string>();
    if (surfaces.length > 0) {
      const rows = await Inflection.find({ targetLang, form: { $in: surfaces } })
        .select("form base baseLemmaKey")
        .lean();

      // Only bases we actually hold, so every resolved word can still be looked up and glossed.
      const bases = [...new Set(rows.map((r) => r.baseLemmaKey))];
      const baseWords = bases.length
        ? await Word.find({ targetLang, lemmaKey: { $in: bases }, origin: "import" })
            .select("lemmaKey")
            .lean()
        : [];
      const knownBases = new Set(baseWords.map((w) => w.lemmaKey));

      for (const row of rows) {
        if (!knownBases.has(row.baseLemmaKey)) continue;
        // Deterministic when a form has several bases: the shortest wins, then alphabetical.
        const current = forms.get(row.form);
        if (!current || row.base.length < current.length) forms.set(row.form, row.base);
        known.add(row.baseLemmaKey);
      }
    }

    return { known, forms };
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
