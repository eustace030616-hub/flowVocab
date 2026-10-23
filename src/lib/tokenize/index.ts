/**
 * Tokenisation and lemmatisation — the single seam every click depends on.
 *
 * The original app split paragraphs on " " and keyed every mark by the resulting array
 * index. That is an English-only assumption baked into the data model:
 *
 *   German   compounds are one token but several learnable items ("Wortschatzaufbau"),
 *            separable verbs split across the clause ("steht … auf" → aufstehen),
 *            and inflections never match the headword ("gelesen" → lesen)
 *   Chinese  has no spaces at all
 *
 * So marks are keyed by character span, not array index, and lemmatisation happens here
 * rather than in the UI. This module is imported by both the client and the API so a
 * click and a write agree on what the learner touched.
 *
 * `matched` on every span records whether a lexicon confirmed the lemma. Rules alone are
 * best-effort; callers must not treat an unmatched lemma as ground truth.
 */

import type { TargetLang } from "../lang";
import { LOCALE_OF } from "../lang";
import { lemmaKeyOf, nfc } from "./normalize";
import { candidatesFor, resolveLemma, type LemmaLookup } from "./rules";

export { resolveLemma, candidatesFor, type LemmaLookup } from "./rules";
export * from "./normalize";

/**
 * Bump when tokenisation changes shape. Persisted spans record the version that produced
 * them so a future re-tokenisation can tell which marks need recomputing.
 */
export const TOKENIZER_VERSION = 1;

export interface Detached {
  start: number;
  end: number;
}

export type SpanKind = "word" | "number" | "punct";

export interface Span {
  /** Exactly the text at [start, end) — rendering is lossless when spans are concatenated. */
  surface: string;
  /** Canonical display form. German nouns keep their capital. */
  lemma: string;
  /** Primary join key: NFC + casefold. */
  lemmaKey: string;
  lang: TargetLang;
  start: number;
  end: number;
  kind: SpanKind;
  /** True when a lexicon confirmed the lemma chosen. */
  matched: boolean;
  /** Separable particles that belong to this item (German). */
  detached?: Detached[];
  /** For a particle span: the char start of the item that absorbed it. */
  absorbedInto?: number;
  /** Compound parts, when they could all be resolved (German). */
  compoundParts?: string[];
}

export interface TokenizeOptions {
  /**
   * Pre-segmented tokens, in order, as offsets into the text.
   *
   * Supplying these replaces the ICU segmenter and nothing else: lemmas, particles and compounds are
   * resolved from the same spans afterwards.
   */
  tokens?: Array<{ surface: string; start: number; end: number }>;
  /** Lexicon probe. Supplying it turns best-effort lemmatisation into lookup-backed lemmatisation. */
  lookup?: LemmaLookup;
  /**
   * Stated form→citation-form mapping, e.g. `liest` → `lesen`, `kurzen` → `kurz`.
   *
   * Takes priority over the suffix rules because it is *stated* rather than guessed, and because
   * the rules cannot get these right: the stem changes between `lesen` and `liest`, so the rules
   * matched the surface against an unrelated noun entry instead.
   */
  resolveForm?: (form: string) => string | null;
  /**
   * Parts of speech known for a candidate, when a lexicon can supply them.
   *
   * Separable-particle attachment is a statement about *verbs*: the particle and the verb it
   * belongs to form a verb. Without this, any listed particle could fuse with any nearby word —
   * "kurzen Text" merged into the noun *Kurztext*, because "kurz" is a genuine separable prefix
   * (kurzarbeiten) and *Kurztext* happens to exist.
   */
  posOf?: (candidate: string) => string[];
  /**
   * Stated separable verbs: `("auf", "stehen")` → `"aufstehen"`.
   *
   * With `hasSeparations` set, this is authoritative and the proximity heuristic does not run at all.
   * That heuristic produced *einwachsen* from "wächst eine", *Kurztext* from "kurzen Text" and
   * *gegenübersetzen* from "setzte … gegenüber" — whether a word is a particle is a syntactic fact,
   * and Wiktionary states it (`auf.stehen`) while proximity cannot.
   */
  separationOf?: (particle: string, verb: string) => string | null;
  /** Whether a separation table has been compiled. Empty means fall back to the heuristic. */
  hasSeparations?: boolean;
  /**
   * Whether a word is a separated prefix *according to the compiled table*.
   *
   * Used instead of the hand-written prefix list when the table exists, so the list cannot be the
   * reason a real prefix is missed.
   */
  isParticle?: (candidate: string) => boolean;
  /** Stated compound parts for a form, when a compound table has been compiled. */
  compoundPartsOf?: (form: string) => string[] | undefined;
  hasCompounds?: boolean;
  /** Detect separable verbs (German only, on by default). */
  separable?: boolean;
  /** Split compounds into parts when every part resolves (German only, on by default). */
  compounds?: boolean;
}

/**
 * German separable prefixes. Deliberately excludes the inseparable ones
 * (be-, emp-, ent-, er-, ge-, miss-, ver-, zer-) which must never be detached.
 */
export const SEPARABLE_PARTICLES = new Set([
  "ab", "an", "auf", "aus", "auseinander", "bei", "beisammen", "bereit", "dar", "durch",
  "ein", "empor", "entgegen", "entlang", "entzwei", "fern", "fest", "fort", "frei",
  "gegenüber", "gleich", "heim", "her", "herab", "heran", "herauf", "heraus", "herbei",
  "herein", "herum", "herunter", "hervor", "hin", "hinab", "hinauf", "hinaus", "hinein",
  "hinten", "hinter", "hinunter", "hinweg", "hinzu", "hoch", "inne", "kalt", "klar",
  "kund", "kurz", "leer", "los", "mit", "nach", "nahe", "nieder", "offen", "preis",
  "schief", "statt", "still", "teil", "tot", "voll", "vor", "voran", "voraus", "vorbei",
  "vorüber", "wahr", "warm", "weg", "weich", "weiter", "wert", "wieder", "zurecht",
  "zurück", "zusammen", "zuwider", "zwischen", "übrig", "zu",
]);

/**
 * Whether a word can be a separated prefix.
 *
 * The compiled table answers this when it is present: a prefix it has no rows for is not one, and the
 * hand-written list is only the fallback for a clone that has not run the compile step. The list is
 * how "zu" came to be missing — a set of 78 prefixes maintained by hand will always be missing one,
 * and it was missing "zumachen", "zuhören", "zusehen".
 */
function isParticleCandidate(lemmaKey: string, options: TokenizeOptions): boolean {
  if (options.hasSeparations && options.isParticle) return options.isParticle(lemmaKey);
  return SEPARABLE_PARTICLES.has(lemmaKey);
}

const INSEPARABLE_PREFIXES = ["be", "emp", "ent", "er", "ge", "miss", "ver", "zer"];

/**
 * Coordinating conjunctions that end a clause as far as particle placement is concerned.
 */
const CLAUSE_BOUNDARY_WORDS = new Set(["und", "aber", "oder", "denn", "sondern", "doch", "jedoch"]);

/** Real punctuation, as opposed to the whitespace the segmenter also reports as non-word-like. */
const BOUNDARY_PUNCTUATION = /[.,;:!?…)»"”]/;

/**
 * Punctuation that ends a clause outright.
 *
 * Narrower than the boundary set above: a comma separates parts of one clause, and a separated verb
 * can straddle one, so only these stop the search for a particle's host.
 */
const SENTENCE_PUNCTUATION = /[.;:!?…]/;

/**
 * Whether a token ends its clause.
 *
 * A separated particle only ever appears at the end of its clause — that is where German puts it
 * ("sie steht früh **auf**"). Without this test, any listed particle adjacent to any verb could
 * fuse: in "wächst eine Pflanze", the article "eine" follows the verb "wächst", and *einwachsen*
 * is a real separable verb, so the pair merged and both words lost their own lemmas.
 */
function isClauseFinal(spans: Span[], index: number): boolean {
  for (let k = index + 1; k < spans.length; k += 1) {
    const next = spans[k];
    if (next.kind === "punct") {
      if (BOUNDARY_PUNCTUATION.test(next.surface)) return true;
      continue; // whitespace between tokens is not a boundary by itself
    }
    if (next.kind === "word") return CLAUSE_BOUNDARY_WORDS.has(next.lemmaKey);
    return false;
  }
  return true; // end of text
}

/**
 * The forms under which a candidate verb might be listed in a separation table.
 *
 * Its own lemma first, because that is what the tokenizer already resolved; then the form a
 * morphological source states it inflects from; then the rule-derived stems, which are all a verb
 * with no stated inflection has.
 */
function hostCandidates(verb: Span, options: TokenizeOptions): string[] {
  const out: string[] = [];
  const push = (candidate: string | null | undefined) => {
    if (candidate && candidate.length > 1 && !out.includes(candidate)) out.push(candidate);
  };
  push(verb.lemmaKey);
  push(options.resolveForm?.(verb.surface));
  for (const stem of candidatesFor(verb.surface, "de")) push(stem);
  return out;
}

/** Finite-verb endings, used only in the no-lexicon fallback path. */
const FINITE_VERB_ENDINGS = ["t", "e", "st", "en"];

function classify(segment: string, isWordLike: boolean | undefined): SpanKind {
  if (!isWordLike) return "punct";
  return /\d/.test(segment) ? "number" : "word";
}

/**
 * Split a German compound into parts, if every part resolves.
 *
 * Two parts only, and only when the lexicon confirms both sides — an unconfirmed split is
 * a guess, and a wrong split is worse than no split because it invents a vocabulary item
 * the learner never met. German heads are on the right, so the longest right-hand part wins.
 */
export function splitCompound(
  surface: string,
  lookup: LemmaLookup | undefined,
  minPart = 3,
): string[] {
  if (!lookup) return [];
  const key = lemmaKeyOf(surface);
  if (key.length < 6) return [];

  for (let i = key.length - minPart; i >= minPart; i--) {
    const right = key.slice(i);
    let left = key.slice(0, i);
    // linking elements: Arbeit+s+Zimmer, Straße+n+Ecke
    for (const linking of ["", "s", "n", "en", "es", "er"]) {
      const candidateLeft = linking && left.endsWith(linking)
        ? left.slice(0, left.length - linking.length)
        : left;
      if (linking && candidateLeft === left) continue;
      if (candidateLeft.length < minPart) continue;
      if (lookup(candidateLeft) && lookup(right)) {
        return [candidateLeft, right];
      }
    }
  }
  return [];
}

/**
 * Reattach separable particles to their verb.
 *
 * "Der Wortschatzaufbau steht morgen früh auf" → the span for "steht" carries
 * lemma "aufstehen" and a `detached` pointer to the "auf" span. The particle span itself
 * records `absorbedInto`, so the UI can highlight both halves as one item.
 */
function attachSeparableParticles(
  spans: Span[],
  lookup?: LemmaLookup,
  posOf?: (candidate: string) => string[],
  options: TokenizeOptions = {},
): void {
  const WINDOW = 8;

  for (let i = 0; i < spans.length; i++) {
    const particle = spans[i];
    if (particle.kind !== "word" || particle.absorbedInto !== undefined) continue;
    if (!isParticleCandidate(particle.lemmaKey, options)) continue;
    // A particle sits at the end of its clause. Anything still following it means this token is
    // doing some other job — an article, a preposition, an adjective.
    if (!isClauseFinal(spans, i)) continue;

    // Search *backwards*, inside this clause only.
    //
    // A particle is clause-final, so its verb is the finite verb earlier in the same clause — never
    // one in the next sentence. Scanning forwards as well found the wrong host across a full stop:
    // in "Ich mache das Fenster auf. Sie kommt an mich." the particle `auf` reached past the period
    // to `kommt`, and (auf, kommen) is a real pair, so the sentence came back as *aufkommen*.
    const clauseStart = clauseStartBefore(spans, i);

    for (let j = i - 1; j >= clauseStart && i - j <= WINDOW; j--) {
      const verb = spans[j];
      if (verb.kind !== "word") continue;
      if (verb.absorbedInto !== undefined || verb.detached?.length) continue;

      const merged = mergedInfinitive(particle.lemmaKey, verb, lookup, posOf, options);
      if (!merged) continue;

      verb.lemma = merged.lemma;
      verb.lemmaKey = merged.lemmaKey;
      verb.matched = merged.matched;
      verb.detached = [...(verb.detached ?? []), { start: particle.start, end: particle.end }];
      particle.absorbedInto = verb.start;
      break;
    }
  }
}

/**
 * Where the current clause begins, so a particle cannot reach into an earlier or later sentence.
 *
 * Sentence-ending punctuation is the boundary; a comma is not, because a separated verb can straddle
 * one without changing clause. Whitespace spans are already excluded from the token stream.
 */
function clauseStartBefore(spans: Span[], index: number): number {
  for (let k = index - 1; k >= 0; k -= 1) {
    const span = spans[k];
    if (span.kind === "punct" && SENTENCE_PUNCTUATION.test(span.surface)) return k + 1;
  }
  return 0;
}

/**
 * Whether a candidate can be the verb of a separable verb.
 *
 * With no part-of-speech information the morphological heuristic is all there is, so the check is
 * skipped and behaviour is unchanged. When a lexicon does know, a candidate that is positively
 * *not* a verb ends the merge: that is what stops "kurzen Text" becoming *Kurztext*.
 */
function isVerbLike(candidate: string, posOf?: (candidate: string) => string[]): boolean {
  if (!posOf) return true;
  const pos = posOf(candidate);
  if (pos.length === 0) return true;
  return pos.includes("verb");
}

function mergedInfinitive(
  particleKey: string,
  verb: Span,
  lookup?: LemmaLookup,
  posOf?: (candidate: string) => string[],
  options: TokenizeOptions = {},
): { lemma: string; lemmaKey: string; matched: boolean } | null {
  // A compiled table is the answer, not a suggestion: if it has no pair for this particle and verb,
  // they do not belong together, however close they happen to sit on the page.
  if (options.hasSeparations && options.separationOf) {
    // The host's own lemma is not always the verb's base form. "Ich mache das Fenster auf" is the
    // clear case: *Mache* is a DWDS noun headword, so `mache` keeps that lemma, while the stated
    // inflection `mache → machen` is what pairs with the particle. The particle's presence is exactly
    // the evidence that resolves the homograph, so its base form is tried as well as its lemma —
    // and the rule-derived stems after that, for verbs with no stated inflection at all.
    for (const host of hostCandidates(verb, options)) {
      const stated = options.separationOf(particleKey, host);
      if (stated && (!lookup || lookup(stated))) {
        return { lemma: stated, lemmaKey: stated, matched: true };
      }
    }
    return null;
  }

  // The host has to be able to be a verb at all.
  if (!isVerbLike(verb.lemmaKey, posOf)) return null;

  const stems = candidatesFor(verb.surface, "de").filter(
    (c) => !INSEPARABLE_PREFIXES.some((p) => c.startsWith(p) && c.length > p.length + 2),
  );

  for (const stem of stems) {
    for (const form of [particleKey + stem, particleKey + stem + "en", particleKey + stem + "e"]) {
      if (lookup) {
        // …and the merged form has to be a verb too. *Kurztext* is a real entry, so the existence
        // check alone would accept it.
        if (lookup(form) && isVerbLike(form, posOf)) {
          return { lemma: form, lemmaKey: form, matched: true };
        }
      } else if (
        form.endsWith("en") &&
        FINITE_VERB_ENDINGS.some((e) => stem.endsWith(e)) &&
        form.length >= 5
      ) {
        // No lexicon: accept the most plausible infinitive, flagged unmatched.
        return { lemma: form, lemmaKey: form, matched: false };
      }
    }
  }
  return null;
}

/**
 * Tokenise losslessly: concatenating `surface` over the returned spans reproduces the input
 * exactly, so the UI can render spans directly and never has to re-derive positions.
 */

/**
 * The tokens plus a span for every gap between them.
 *
 * The segmenter reports words and punctuation; the reading interface needs the spaces too, because it
 * renders the spans it is given and nothing else.
 */
function fillGaps(
  text: string,
  tokens: Array<{ surface: string; start: number; end: number }>,
): Array<{ segment: string; index: number; isWordLike: undefined }> {
  const parts: Array<{ segment: string; index: number; isWordLike: undefined }> = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      parts.push({ segment: text.slice(cursor, token.start), index: cursor, isWordLike: undefined });
    }
    if (token.start >= cursor) {
      parts.push({ segment: text.slice(token.start, token.end), index: token.start, isWordLike: undefined });
      cursor = token.end;
    }
  }
  if (cursor < text.length) {
    parts.push({ segment: text.slice(cursor), index: cursor, isWordLike: undefined });
  }
  return parts;
}

export function tokenize(
  text: string,
  lang: TargetLang,
  options: TokenizeOptions = {},
): Span[] {
  const { lookup, resolveForm, posOf, separable = lang === "de", compounds = lang === "de", tokens } = options;
  const input = nfc(text);
  const segmenter = new Intl.Segmenter(LOCALE_OF[lang], { granularity: "word" });

  // Segmentation is the only thing a caller may replace: SoMaJo knows German abbreviations, quotes and
  // ordinals better than ICU, and everything downstream — lemmas, particles, compounds — stays identical
  // because it sees the same spans either way.
  // A foreign segmenter returns only words and punctuation, not the gaps between them. The reader renders
  // from spans, so a missing gap would join two words: fill every gap with its own span, whitespace or
  // not, exactly as the ICU segmenter reports them.
  const parts = tokens
    ? fillGaps(
        input,
        tokens
          .filter((token) => token.start >= 0 && token.end <= input.length && token.start < token.end)
          .sort((a, b) => a.start - b.start),
      ).map((part) => ({
        ...part,
        isWordLike: /[\p{L}\p{N}]/u.test(part.segment) ? true : false,
      }))
    : [...segmenter.segment(input)];

  const spans: Span[] = [];
  for (const part of parts) {
    const kind = classify(part.segment, part.isWordLike);
    const start = part.index;
    const end = start + part.segment.length;

    if (kind === "punct") {
      spans.push({
        surface: part.segment,
        lemma: part.segment,
        lemmaKey: lemmaKeyOf(part.segment),
        lang,
        start,
        end,
        kind,
        matched: false,
      });
      continue;
    }

    // A stated citation form wins over the rules — but not over the word itself. "Pflanze" is a
    // noun with its own entry, and "pflanze" is also the first person of "pflanzen", so the form
    // map alone would lemmatise the plant into the verb. An entry that carries a part of speech is
    // a real word and keeps its own lemma; only an unclassified or absent one defers.
    const surfaceKey = lemmaKeyOf(part.segment);
    const surfaceIsClassified = (posOf?.(surfaceKey)?.length ?? 0) > 0;
    const statedBase =
      kind === "word" && !surfaceIsClassified ? resolveForm?.(surfaceKey) ?? null : null;
    const resolved = statedBase
      ? {
          lemma: statedBase,
          lemmaKey: lemmaKeyOf(statedBase),
          matched: lookup ? lookup(lemmaKeyOf(statedBase)) : false,
          candidates: [statedBase],
        }
      : resolveLemma(part.segment, lang, kind === "word" ? lookup : undefined);
    const span: Span = {
      surface: part.segment,
      lemma: resolved.lemma,
      lemmaKey: resolved.lemmaKey,
      lang,
      start,
      end,
      kind,
      matched: resolved.matched,
    };

    // Decompose only an unknown word. A word the lexicon already resolved is not a compound
    // problem — it is an inflection, a known compound, or an ordinary word.
    if (compounds && kind === "word" && !resolved.matched) {
      const form = lemmaKeyOf(part.segment);
      const stated = options.compoundPartsOf?.(form);
      if (options.hasCompounds) {
        // Authoritative: a compiled table says which forms split and how. No guessing.
        if (stated?.length) span.compoundParts = stated;
      } else {
        const parts = splitCompound(part.segment, lookup);
        if (parts.length) span.compoundParts = parts;
      }
    }

    spans.push(span);
  }

  if (separable) attachSeparableParticles(spans, lookup, posOf, options);

  return spans;
}

/** Word-like spans only — the units that count toward coverage. */
export function wordSpans(spans: Span[]): Span[] {
  return spans.filter((s) => s.kind === "word" || s.kind === "number");
}

/**
 * Lexical coverage: the share of tokens the learner is estimated to know.
 *
 * This is the operational definition of i+1 (Nation 2006; Laufer & Ravenhorst-Kalovski 2010):
 * below ~0.95 is too hard, at or above ~0.98 is comfortable free reading. Reported here so
 * the serving logic has a single source of truth.
 */
export function coverage(
  spans: Span[],
  known: (span: Span) => boolean,
): { coverage: number; unknown: number; total: number } {
  const units = wordSpans(spans);
  if (units.length === 0) return { coverage: 1, unknown: 0, total: 0 };
  let unknown = 0;
  for (const s of units) if (!known(s)) unknown += 1;
  return { coverage: (units.length - unknown) / units.length, unknown, total: units.length };
}
