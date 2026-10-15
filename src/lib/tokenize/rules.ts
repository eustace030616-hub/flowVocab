/**
 * Rule-based lemma candidate generation.
 *
 * Deliberately conservative: this produces *candidates* in priority order, and the caller
 * picks the first one that a lexicon recognises. Without a lexicon we fall back to the
 * top candidate, which is best-effort and documented as such — the imported word list
 * (CEFR-J/Octanove for English, DWDS/kaikki for German) is what makes it accurate.
 *
 * The rule engine never claims more than it can: every result carries `matched`, so the
 * learner model can weight an item it merely guessed at.
 */

import type { TargetLang } from "../lang";
import { lemmaKeyOf, nfc, umlautVariants } from "./normalize";

/** Returns true when the candidate is a real headword in the active lexicon. */
export type LemmaLookup = (candidateKey: string) => boolean;

export interface LemmaResult {
  /** Canonical surface form to display (keeps German capitalisation). */
  lemma: string;
  /** Join key: NFC + casefold. */
  lemmaKey: string;
  /** True when the chosen candidate was confirmed by the lexicon. */
  matched: boolean;
  /** All candidates tried, in priority order — useful for debugging and eval. */
  candidates: string[];
}

/**
 * English irregulars. Small on purpose: the lexicon handles the regular cases, and a long
 * hand-written table is a maintenance liability that the imported forms table replaces.
 */
const EN_IRREGULAR: Record<string, string> = {
  am: "be", is: "be", are: "be", was: "be", were: "be", been: "be", being: "be",
  has: "have", had: "have", having: "have",
  does: "do", did: "do", done: "do", doing: "do",
  goes: "go", went: "go", gone: "go",
  runs: "run", ran: "run", running: "run",
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose", people: "person", lives: "life", wives: "wife",
  better: "good", best: "good", worse: "bad", worst: "bad",
  said: "say", made: "make", took: "take", taken: "take", gave: "give", given: "give",
  found: "find", thought: "think", brought: "bring", bought: "buy", built: "build",
  wrote: "write", written: "write", spoke: "speak", spoken: "speak",
  began: "begin", begun: "begin", became: "become", felt: "feel", kept: "keep",
  left: "leave", meant: "mean", met: "meet", paid: "pay", read: "read",
  sent: "send", sat: "sit", slept: "sleep", spent: "spend", stood: "stand",
  told: "tell", understood: "understand", wore: "wear", worn: "wear", won: "win",
};

/** Endings that must never be stripped, or "bus" becomes "bu" and "class" becomes "clas". */
const EN_NO_STRIP = new Set([
  "this", "his", "its", "was", "has", "as", "is", "us", "yes", "gas", "bus",
  "class", "glass", "grass", "pass", "less", "miss", "boss", "cross", "press",
  "news", "series", "species", "physics", "maths", "always", "perhaps",
]);

export function englishCandidates(surface: string): string[] {
  const key = lemmaKeyOf(surface);
  const out: string[] = [];
  /**
   * Add a candidate, with a minimum length that applies to *derived* forms only.
   *
   * Suffix stripping can produce a one-letter fragment ("ies" → "y" → nothing useful), which should
   * not be looked up. The word itself is different: English has one-letter words — "a" and "I" — and
   * the guard was rejecting them, so both were permanently unresolved despite being in the
   * vocabulary with glosses. "a" is in almost every English sentence, and the reader was treating it
   * as an unknown word and showing no translation for it.
   */
  const push = (c: string, minLength = 2) => {
    if (c.length >= minLength && !out.includes(c)) out.push(c);
  };

  // The word itself, however short: identity is always a candidate.
  push(key, 1);

  const irregular = EN_IRREGULAR[key];
  if (irregular) push(irregular);

  if (key.length > 3 && !EN_NO_STRIP.has(key)) {
    // plural / 3rd person singular
    if (key.endsWith("ies")) push(key.slice(0, -3) + "y");
    if (key.endsWith("es")) push(key.slice(0, -2));
    if (key.endsWith("s") && !key.endsWith("ss") && !key.endsWith("us") && !key.endsWith("is")) {
      push(key.slice(0, -1));
    }
    // past tense / participle
    if (key.endsWith("ied")) push(key.slice(0, -3) + "y");
    if (key.endsWith("ed")) {
      push(key.slice(0, -2));
      push(key.slice(0, -1)); // e.g. "loved" -> "love"
    }
    // progressive
    if (key.endsWith("ing")) {
      push(key.slice(0, -3));
      push(key.slice(0, -3) + "e"); // e.g. "making" -> "make"
    }
    // comparative / superlative
    if (key.endsWith("est")) {
      push(key.slice(0, -3));
      push(key.slice(0, -2));
    }
    if (key.endsWith("er")) {
      push(key.slice(0, -2));
      push(key.slice(0, -1));
    }
  }

  // doubled consonant before -ing/-ed: "running" -> "runn" -> "run"
  for (const c of [...out]) {
    const m = /^(.+?)([bcdfglmnprst])\2$/.exec(c);
    if (m) push(m[1] + m[2]);
  }

  return out;
}

/**
 * German endings worth stripping.
 *
 * Split into two groups because the *preferred* lemma differs. For a finite verb form the
 * infinitive is the better guess — "braucht" should resolve to "brauchen", not to "Brauch" (a
 * noun meaning custom, which happens to exist). For a noun or adjective the bare stem is the
 * better guess — "Wortes" should resolve to "Wort", not to "worten".
 *
 * This is a heuristic standing in for part-of-speech information. A lexicon that returned POS
 * would resolve these exactly; until then the ambiguity is documented rather than hidden.
 */
const DE_VERB_SUFFIXES = ["test", "tet", "ten", "te", "est", "et", "st", "en", "e", "t"];
const DE_NOUN_SUFFIXES = ["ste", "ster", "sten", "es", "s", "n", "er", "e"];

export function germanCandidates(surface: string): string[] {
  const key = lemmaKeyOf(surface);
  const out: string[] = [];
  const push = (c: string) => {
    if (c.length >= 2 && !out.includes(c)) out.push(c);
  };

  push(key);
  for (const v of umlautVariants(key)) push(v);

  // ge-…-t / ge-…-en participles: "gemacht" -> "machen"
  if (key.startsWith("ge") && key.length > 4) {
    const stem = key.slice(2);
    if (stem.endsWith("t")) {
      push(stem.slice(0, -1) + "en");
      push(stem.slice(0, -1) + "e");
    }
    if (stem.endsWith("en")) push(stem);
  }

  const base = key.startsWith("ge") && key.length > 4 ? key.slice(2) : key;
  const consider = (stem: string, preferInfinitive: boolean) => {
    const forms = preferInfinitive
      ? [stem + "en", stem + "e", stem]
      : [stem, stem + "en", stem + "e"];
    for (const form of forms) push(form);
    for (const variant of umlautVariants(stem)) {
      push(variant);
      push(variant + "en");
    }
  };

  for (const suffix of DE_VERB_SUFFIXES) {
    if (base.endsWith(suffix) && base.length - suffix.length >= 3) {
      consider(base.slice(0, base.length - suffix.length), true);
    }
  }
  for (const suffix of DE_NOUN_SUFFIXES) {
    if (base.endsWith(suffix) && base.length - suffix.length >= 3) {
      consider(base.slice(0, base.length - suffix.length), false);
    }
  }

  return out;
}

export function candidatesFor(surface: string, lang: TargetLang): string[] {
  return lang === "de" ? germanCandidates(surface) : englishCandidates(surface);
}

/**
 * Resolve a surface form to a lemma.
 *
 * With a lexicon, the first recognised candidate wins. Without one, the top candidate is
 * returned with `matched: false` — the caller must not treat that as ground truth.
 */
export function resolveLemma(
  surface: string,
  lang: TargetLang,
  lookup?: LemmaLookup,
): LemmaResult {
  const candidates = candidatesFor(surface, lang);
  const display = nfc(surface);

  if (lookup) {
    for (const c of candidates) {
      if (lookup(c)) {
        return {
          lemma: lang === "de" && /^[A-ZÄÖÜ]/.test(display) ? capitalise(c) : c,
          lemmaKey: c,
          matched: true,
          candidates,
        };
      }
    }
  }

  const top = candidates[0] ?? lemmaKeyOf(surface);
  return {
    lemma: lang === "de" && /^[A-ZÄÖÜ]/.test(display) ? capitalise(top) : top,
    lemmaKey: top,
    matched: false,
    candidates,
  };
}

export function capitalise(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}
