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
  "zurück", "zusammen", "zuwider", "zwischen", "übrig",
]);

const INSEPARABLE_PREFIXES = ["be", "emp", "ent", "er", "ge", "miss", "ver", "zer"];

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
function attachSeparableParticles(spans: Span[], lookup?: LemmaLookup): void {
  const WINDOW = 8;

  for (let i = 0; i < spans.length; i++) {
    const particle = spans[i];
    if (particle.kind !== "word" || particle.absorbedInto !== undefined) continue;
    if (!SEPARABLE_PARTICLES.has(particle.lemmaKey)) continue;

    const lo = Math.max(0, i - WINDOW);
    const hi = Math.min(spans.length - 1, i + WINDOW);

    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const verb = spans[j];
      if (verb.kind !== "word") continue;
      if (verb.absorbedInto !== undefined || verb.detached?.length) continue;
      if (verb.lemmaKey.startsWith("zu") && j === i) continue;

      const merged = mergedInfinitive(particle.lemmaKey, verb, lookup);
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

function mergedInfinitive(
  particleKey: string,
  verb: Span,
  lookup?: LemmaLookup,
): { lemma: string; lemmaKey: string; matched: boolean } | null {
  const stems = candidatesFor(verb.surface, "de").filter(
    (c) => !INSEPARABLE_PREFIXES.some((p) => c.startsWith(p) && c.length > p.length + 2),
  );

  for (const stem of stems) {
    for (const form of [particleKey + stem, particleKey + stem + "en", particleKey + stem + "e"]) {
      if (lookup) {
        if (lookup(form)) {
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
export function tokenize(
  text: string,
  lang: TargetLang,
  options: TokenizeOptions = {},
): Span[] {
  const { lookup, resolveForm, separable = lang === "de", compounds = lang === "de" } = options;
  const input = nfc(text);
  const segmenter = new Intl.Segmenter(LOCALE_OF[lang], { granularity: "word" });

  const spans: Span[] = [];
  for (const part of segmenter.segment(input)) {
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

    // A stated citation form wins over anything the rules can propose.
    const statedBase = kind === "word" ? resolveForm?.(lemmaKeyOf(part.segment)) : null;
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
      const parts = splitCompound(part.segment, lookup);
      if (parts.length) span.compoundParts = parts;
    }

    spans.push(span);
  }

  if (separable) attachSeparableParticles(spans, lookup);

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
