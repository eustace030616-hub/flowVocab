/**
 * Parser for Frank Richter's *ding* / Beolingus German–English dictionary.
 *
 * Licence: GPL-3+. The data is copyleft, which is why it lands in its own `Gloss` documents
 * rather than being merged into the shared vocabulary (see models/Gloss.ts).
 *
 * Format, one entry per line:
 *
 *     Aalbestand {m} | Aalbestände {pl} :: eel stock | eel stocks
 *     Aalen {n}; Aalenium {n} (erdgeschichtliche Stufe) [geol.] :: Aalenian (stage in the Earth's history)
 *     Aalmolche {pl}; Fischmolche {pl} (Amphiuma) [zool.] <Aalmolch> :: amphiuma salamanders; congo eels [coll.]
 *
 *   German side :: English side
 *   `;` separates synonyms within a group, `|` separates the singular group from the plural group
 *   `{m}` `{f}` `{n}` `{pl}` carry gender, `[...]` is a domain tag, `(...)` a gloss on the term
 *
 * Pure and separate from the database so the shape can be tested against the real file.
 */

import { lemmaKeyOf } from "../../lib/tokenize/normalize";

export type DingGender = "der" | "die" | "das";

export interface DingEntry {
  /** Primary German headword, cleaned of markers. */
  headword: string;
  lemmaKey: string;
  /** Definite article, derived from the gender marker. */
  article?: DingGender;
  /** Plural form, only when the entry marks one with `{pl}`. */
  plural?: string;
  /** English glosses for the headword itself, best first. */
  glosses: string[];
  /** Secondary German spellings, useful as surface forms. */
  variants: string[];

  // Ranking hints. This is a *phrase* dictionary: one line lists the headword and then a run of
  // example phrases, with the English side mirroring them slot for slot. So the first slot is the
  // translation and every later slot is an example, and a headword can appear on several lines
  // for different senses or domains. These two flags let the importer prefer the plain reading.
  hasDomainTag: boolean;
  headwordHasSynonyms: boolean;
  /**
   * Number of `|`-separated slots on the line.
   *
   * Richness is the strongest signal for "which line is the canonical entry": `Wasser` appears on
   * a 67-slot line glossed "water" and on a stray 1-slot line glossed "eau". The rich line is the
   * dictionary entry; the thin ones are fragments.
   */
  slotCount: number;
}

/**
 * `{marker}`, `[domain]`, `(gloss)`, `<variant>`, `/notation/` — all metadata, none of it the term.
 *
 * Markers must be removed **before** splitting on `;` and `|`, because a marker can contain those
 * separators: `to understand {understood; understood}` splits into two malformed half-glosses if the
 * split happens first, which is exactly what it did.
 *
 * The `/…/` alternative is restricted to a short run with no spaces so it catches pronunciation and
 * formula notations (`/H₂O/`, `/soltn/`) without eating a genuine pair of slashes in a phrase.
 */
const MARKERS = /\{[^}]*\}|\[[^\]]*\]|\([^)]*\)|<[^>]*>|\/[^\s/]{1,40}\//g;

/** Strip metadata from a whole side of a line, before any splitting. */
export function stripMarkers(input: string): string {
  return input.replace(MARKERS, " ");
}

/** Tidy a term that has already had its markers removed. */
export function cleanTerm(input: string): string {
  return stripMarkers(input)
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:…–-]+/, "")
    .replace(/[\s.,;:…–-]+$/, "")
    .trim();
}

const GENDER: Record<string, DingGender> = { m: "der", f: "die", n: "das" };

/** German plural nouns take *die*, e.g. "Aalmolche {pl}" → die Aalmolche. */
function articleFor(markers: string, hasPluralMarker: boolean): DingGender | undefined {
  if (hasPluralMarker) return "die";
  const single = /\{([mfn])\}/.exec(markers);
  return single ? GENDER[single[1]] : undefined;
}

function firstSlotTerm(slot: string): string {
  const first = slot.split(";")[0]?.trim() ?? "";
  return cleanTerm(first);
}

export function parseDingLine(line: string, maxGlosses = 3): DingEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const split = trimmed.indexOf(" :: ");
  if (split <= 0) return null;

  // Keep the RAW German side: the `{m}`/`{f}`/`{n}`/`{pl}` markers are stripped for the term text
  // but are the only source of gender and plural, so they must be read before stripping.
  const germanRaw = trimmed.slice(0, split);
  const germanRawSlots = germanRaw.split("|");
  const rawHeadwordSlot = germanRawSlots[0] ?? "";

  // Markers are removed before any splitting: they can contain `;` and `|`.
  const germanSlots = stripMarkers(germanRaw)
    .split("|")
    .map((slot) => slot.trim())
    .filter(Boolean);
  const englishSide = stripMarkers(trimmed.slice(split + 4));
  if (!englishSide.trim() || germanSlots.length === 0) return null;

  const headwordSlot = germanSlots[0];
  const headwordVariants = headwordSlot.split(";").map((v) => v.trim()).filter(Boolean);
  if (headwordVariants.length === 0) return null;

  const headword = cleanTerm(headwordVariants[0]);
  if (!headword) return null;

  const markers = (rawHeadwordSlot.match(/\{[^}]*\}/g) ?? []).join("");
  const article = articleFor(markers, /\{pl\}/.test(markers));

  // A plural is only claimed when the entry explicitly marks one, and only from the slot directly
  // after the headword — that is where the format puts it. Scanning further slots picks up
  // compounds from the example list and invents plurals that do not exist ("Lösung" → "Prüflösungen").
  let plural: string | undefined;
  const pluralSlot = germanRawSlots[1]?.split(";")[0]?.trim() ?? "";
  if (/\{pl\}/.test(pluralSlot)) {
    const cleaned = cleanTerm(pluralSlot);
    if (cleaned && cleaned !== headword) plural = cleaned;
  }
  if (!plural && /\{pl\}/.test(markers)) plural = headword;

  const variantSet = new Set<string>();
  for (const variant of headwordVariants.slice(1)) {
    const cleaned = cleanTerm(variant);
    if (cleaned && cleaned !== headword) variantSet.add(cleaned);
  }

  // Only the FIRST English slot translates the headword. Later slots mirror the German examples,
  // and treating them as further glosses is how "Haus" collected "to stay home" as a meaning.
  const glosses: string[] = [];
  for (const candidate of (englishSide.split("|")[0] ?? "").split(";")) {
    const cleaned = cleanTerm(candidate);
    if (cleaned && !glosses.includes(cleaned)) glosses.push(cleaned);
    if (glosses.length >= maxGlosses) break;
  }
  if (glosses.length === 0) return null;

  return {
    headword,
    lemmaKey: lemmaKeyOf(headword),
    article,
    plural,
    glosses,
    variants: [...variantSet],
    hasDomainTag: /\[[^\]]*\]/.test(rawHeadwordSlot),
    headwordHasSynonyms: headwordVariants.length > 1,
    slotCount: germanSlots.length,
  };
}

/** Parse a whole dictionary. Skips unparseable lines rather than guessing at them. */
export function parseDing(text: string, maxGlosses = 3): { entries: DingEntry[]; skipped: number } {
  const entries: DingEntry[] = [];
  let skipped = 0;

  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const entry = parseDingLine(line, maxGlosses);
    if (entry) entries.push(entry);
    else skipped += 1;
  }

  return { entries, skipped };
}

/**
 * Rank the candidate lines for one headword, best first.
 *
 * German capitalisation is meaningful — `Verstehen` (the noun, "understanding") and `verstehen`
 * (the verb, "to understand") fold to the same lemma key — so an exact, case-sensitive match
 * against the vocabulary entry's own spelling wins outright. After that, richness identifies the
 * canonical line, then the absence of a domain tag, then a plain headword slot.
 */
export function rankEntries(entries: DingEntry[], targetLemma?: string): DingEntry[] {
  const score = (entry: DingEntry) => {
    const exactCase = targetLemma && entry.headword === targetLemma ? 0 : 1;
    const synonyms = entry.headwordHasSynonyms ? 1 : 0;
    const domain = entry.hasDomainTag ? 1 : 0;
    return [exactCase, -entry.slotCount, domain, synonyms];
  };

  return [...entries].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i += 1) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return 0;
  });
}

/** Group candidate lines by lemma key. */
export function groupByLemma(entries: DingEntry[]): Map<string, DingEntry[]> {
  const grouped = new Map<string, DingEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.lemmaKey);
    if (bucket) bucket.push(entry);
    else grouped.set(entry.lemmaKey, [entry]);
  }
  return grouped;
}
