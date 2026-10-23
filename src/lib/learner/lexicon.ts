/**
 * LEGACY(learner/lexicon)
 *
 * Resolves inflected forms through the `inflections` table and composes compounds from `words`.
 * Simplemma now supplies lemmas as stated forms, and the word book carries the listed forms; this
 *  path stays for text the sidecar did not tag, such as imports.
 */
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

import {
  compoundsByForm,
  inflectionsByForm,
  separationsByParticle,
  wordsByKeys,
} from "../store/dictionary";
import type { TargetLang } from "../lang";
import {
  lemmaKeyOf,
  tokenize,
  wordSpans,
  type LemmaLookup,
  type SegmentToken,
  type Span,
} from "../tokenize";

/** What a lexicon lookup returns: dictionary entries, and stated inflections. */
export interface LexiconData {
  /**
   * Lemma key → the parts of speech known for it. A key being present means the entry exists,
   * so this is both "is it known" and "what is it", which the tokenizer needs to tell a verb from
   * a noun before it fuses a separable particle onto one.
   */
  pos: Map<string, string[]>;
  /** Surface form → citation form, as stated by a morphological source. */
  forms: Map<string, string>;
  /**
   * `particle\0verb` → the merged infinitive, as stated rather than inferred.
   *
   * Empty when the morphology has not been compiled, which is how the tokenizer knows whether to
   * trust a syntax table or fall back to its own heuristics.
   */
  separations: Map<string, string>;
  /** Whole form → its parts, for compounds the lexicon can vouch for. */
  compounds: Map<string, string[]>;
}

/** Key for a (particle, verb) pair. */
export function separationKey(particle: string, verb: string): string {
  return `${particle}\u0000${verb}`;
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
  tokens?: SegmentToken[],
): Promise<Span[]> {
  const known = new Set<string>();
  const forms = new Map<string, string>();

  // Lemmas the segmenter supplied. Simplemma reads the surface and returns the citation form, which is
  // exactly what the `inflections` table did — so when both are present the stated lemma wins, and the
  // dictionary's copy becomes the fallback for tokens the segmenter did not label.
  for (const token of tokens ?? []) {
    if (!token.lemma) continue;
    const key = lemmaKeyOf(token.surface);
    if (key && !forms.has(key)) forms.set(key, token.lemma);
  }

  // Ask about the surfaces up front: a stated inflection short-circuits the rules entirely, so it
  // is worth one query before lexing rather than discovering it after a wrong answer.
  const surfaces = [
    ...new Set(wordSpans(tokenize(text, targetLang, { tokens })).map((s) => lemmaKeyOf(s.surface))),
  ];
  /** lemma key → parts of speech, accumulated across passes. */
  const pos = new Map<string, string[]>();

  const separations = new Map<string, string>();
  const compounds = new Map<string, string[]>();

  const absorb = (data: LexiconData) => {
    for (const [key, value] of data.pos) {
      const existing = pos.get(key);
      if (existing) {
        for (const p of value) if (!existing.includes(p)) existing.push(p);
      } else {
        pos.set(key, [...value]);
      }
    }
    for (const [form, base] of data.forms) forms.set(form, base);
    for (const [pair, merged] of data.separations) separations.set(pair, merged);
    for (const [form, parts] of data.compounds) compounds.set(form, parts);
  };

  absorb(await query([], surfaces));

  /**
   * The options every pass runs with, including the compiled morphology.
   *
   * One builder for all passes. The loop used to construct its own options inline with only
   * `lookup`, `posOf` and `resolveForm`, so the separation and compound tables — loaded, paid for,
   * and the whole point of the compile step — never reached the tokenizer. Every particle merge was
   * therefore still made by the proximity heuristic, which is why "Ich mache das Fenster auf. Sie
   * kommt an mich." came back as *aufkommen*: `mache` is a DWDS noun headword so the heuristic
   * rejected it as a verb, the forward scan crossed the full stop, and (auf, kommen) is a real pair.
   *
   * The fallback pass at the end of this function did use the full set, but reaching it requires the
   * loop to exhaust every pass without converging, which in practice never happens.
   */
  const options = (track?: Set<string>) => ({
    lookup: (candidate: string) => {
      if (pos.has(candidate)) return true;
      track?.add(candidate);
      return false;
    },
    posOf: (candidate: string) => pos.get(candidate) ?? [],
    resolveForm: (form: string) => forms.get(form) ?? null,
    // Stated morphology, when compiled. The tokenizer treats a non-empty table as authoritative and
    // stops guessing; an empty one means the compile step has not been run, and the rules apply.
    separationOf: (particle: string, verb: string) =>
      separations.get(separationKey(particle, verb)) ?? null,
    hasSeparations: separations.size > 0,
    // The particles the table actually knows, among the words in this text.
    isParticle: (candidate: string) => {
      for (const pair of separations.keys()) {
        if (pair.startsWith(`${candidate}\u0000`)) return true;
      }
      return false;
    },
    compoundPartsOf: (form: string) => compounds.get(form),
    hasCompounds: compounds.size > 0,
  });

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const missed = new Set<string>();
    const spans = tokenize(text, targetLang, { ...options(missed), tokens });

    // Nothing new was requested, so another pass would produce identical spans.
    if (missed.size === 0) return spans;

    absorb(await query([...missed], []));
  }

  // Final pass so the returned spans reflect everything learned.
  return tokenize(text, targetLang, { ...options(), tokens });
}

/**
 * The database-backed query: one `$in` per batch, over exactly what was asked for.
 *
 * A stated inflection is only honoured when its base is a real dictionary entry, so a mapping can
 * never resolve a word to something the glossary cannot gloss.
 */
export function datastoreQuery(targetLang: TargetLang): LexiconQuery {
  return async (candidates, surfaces) => {
    const pos = new Map<string, string[]>();
    const separations = new Map<string, string>();
    const compounds = new Map<string, string[]>();

    // Surfaces are asked about as well as candidates, and they need the same answer about their
    // part of speech: the tokenizer decides whether to defer to a stated inflection by asking
    // whether the surface is itself a classified entry, so answering only the candidates left that
    // question unanswered on the very pass that needed it.
    const wanted = [...new Set([...candidates, ...surfaces])];

    if (wanted.length > 0) {
      // Dataset entries only (`origin: "import"`). A word the learner marked is created on the spot,
      // and letting those in would make any marked word look like a dictionary headword.
      const found = wordsByKeys(targetLang, wanted, { origin: "import" });
      for (const word of found) {
        const list = pos.get(word.lemmaKey);
        if (list) {
          if (word.pos && !list.includes(word.pos)) list.push(word.pos);
        } else {
          pos.set(word.lemmaKey, word.pos ? [word.pos] : []);
        }
      }
    }

    const forms = new Map<string, string>();
    if (surfaces.length > 0) {
      const rows = inflectionsByForm(targetLang, surfaces);

      // Only bases we actually hold, so every resolved word can still be looked up and glossed.
      const bases = [...new Set(rows.map((r) => r.baseLemmaKey))];
      const basePos = new Map(
        (bases.length ? wordsByKeys(targetLang, bases, { origin: "import" }) : []).map((w) => [
          w.lemmaKey,
          w.pos ? [w.pos] : [],
        ]),
      );

      for (const row of rows) {
        if (!basePos.has(row.baseLemmaKey)) continue;
        // Deterministic when a form has several bases: the shortest wins, then alphabetical.
        const current = forms.get(row.form);
        if (!current || row.base.length < current.length) forms.set(row.form, row.base);
        if (!pos.has(row.baseLemmaKey)) pos.set(row.baseLemmaKey, [...(basePos.get(row.baseLemmaKey) ?? [])]);
      }
    }

    // Stated separations for the particles in this text, and stated splits for its forms. Both are
    // keyed by things already in the batch, so neither costs a query of its own scale.
    const asked = [...new Set([...candidates, ...surfaces])];
    const particles = asked.filter((word) => word.length > 0 && word.length <= 12);
    if (particles.length > 0) {
      const separationRows = separationsByParticle(targetLang, particles);
      const compoundRows = compoundsByForm(targetLang, asked);
      for (const row of separationRows) {
        separations.set(`${row.particle}\u0000${row.verb}`, row.merged);
      }
      for (const row of compoundRows) {
        if (row.parts?.length) compounds.set(row.form, row.parts);
      }
    }

    return { pos, forms, separations, compounds };
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
  tokens?: SegmentToken[],
): Promise<Span[]> {
  return tokenizeAgainst(text, targetLang, datastoreQuery(targetLang), 3, tokens);
}

export interface LexiconEntry {
  _id: string;
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

  // No origin filter: a marked word needs a row to attach the mark to, even a learner-created stub.
  const docs = wordsByKeys(targetLang, keys, { origin: null });

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
