/**
 * Language identity.
 *
 * Flowwing runs two learner tracks, each a (targetLang, glossLang, uiLocale) triple:
 *
 *   zh-en  a Chinese speaker learning English, glossed in Chinese
 *   en-de  an English speaker learning German,   glossed in English
 *
 * `targetLang` is the language of the *content* (what the learner is learning).
 * `glossLang`  is the language of the *translations* shown on click.
 * `uiLocale`   is the language of the interface chrome.
 *
 * Keeping these three separate is what makes the second track possible at all:
 * a word's identity is (targetLang, lemma, pos) — never just the spelling, because
 * German and English share an alphabet and collide constantly (Gift/gift, fast/also, Bank/bank).
 */

export type TargetLang = "en" | "de";
export type GlossLang = "en" | "zh";
export type UiLocale = "en" | "zh";
export type TrackId = "zh-en" | "en-de";

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export interface Track {
  id: TrackId;
  targetLang: TargetLang;
  glossLang: GlossLang;
  uiLocale: UiLocale;
  label: string;
}

export const TRACKS: Record<TrackId, Track> = {
  "zh-en": {
    id: "zh-en",
    targetLang: "en",
    glossLang: "zh",
    uiLocale: "zh",
    label: "中文 → English",
  },
  "en-de": {
    id: "en-de",
    targetLang: "de",
    glossLang: "en",
    uiLocale: "en",
    label: "English → Deutsch",
  },
};

export const DEFAULT_TRACK: TrackId = "zh-en";

/**
 * Which language glosses content in a given target language.
 *
 * Derived from the *content*, never from the user's stored track. The two can disagree — a request
 * for German paragraphs while the learner's track is still `zh-en` — and reading the gloss language
 * off the track then looks for Chinese glosses on German words and silently finds none. The product
 * decision is fixed anyway: English is glossed in Chinese, German in English.
 */
export const GLOSS_LANG_FOR: Record<TargetLang, GlossLang> = {
  en: "zh",
  de: "en",
};

export function glossLangFor(targetLang: TargetLang): GlossLang {
  return GLOSS_LANG_FOR[targetLang];
}

export function isTrackId(value: unknown): value is TrackId {
  return value === "zh-en" || value === "en-de";
}

export function isTargetLang(value: unknown): value is TargetLang {
  return value === "en" || value === "de";
}

export function trackOf(id: TrackId): Track {
  return TRACKS[id];
}

/** BCP-47 tags for Intl.Segmenter and friends. */
export const LOCALE_OF: Record<TargetLang, string> = {
  en: "en",
  de: "de",
};

export const CEFR_LEVELS: readonly CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function cefrIndex(level: CefrLevel): number {
  return CEFR_LEVELS.indexOf(level);
}

export function isCefrLevel(value: unknown): value is CefrLevel {
  return typeof value === "string" && (CEFR_LEVELS as readonly string[]).includes(value);
}

/**
 * Difficulty is a continuous 0..1 score; CEFR is a human-readable label computed on top of it.
 * `< 0` means "unknown", which is a legitimate value — German has no C1/C2 wordlist, so above
 * B1 the honest answer is a band, not a level.
 */
export const UNKNOWN_DIFFICULTY = -1;
