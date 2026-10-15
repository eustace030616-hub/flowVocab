/**
 * Text normalisation.
 *
 * The rules here exist because German input arrives from several sources that disagree
 * about encoding and capitalisation (DWDS capitalises nouns, Leipzig and OpenSubtitles
 * lean lowercase), and a mismatch silently breaks joins instead of failing loudly.
 *
 * Three distinct keys, in order of authority:
 *
 *   nfc()            storage form — ALWAYS store NFC, never decomposed
 *   lemmaKeyOf()     primary join key — NFC + casefold; the language is part of the key,
 *                    so English and German never collide even when spellings match
 *   foldSearchKey()  SECONDARY search key only — folds ä→ae, ö→oe, ü→ue, ß→ss.
 *                    Never use this as a primary key: it is lossy and many German words
 *                    collapse onto each other under it.
 */

/** Canonical storage form. Decomposed input (e.g. "a" + U+0308) is normalised to "ä". */
export function nfc(input: string): string {
  return input.normalize("NFC");
}

/** Primary join key: NFC, then casefold. Language is a separate key component by design. */
export function lemmaKeyOf(input: string): string {
  return nfc(input).toLowerCase();
}

/**
 * Secondary search key for German: fold umlauts and ß.
 * Use only to widen a lookup after the primary key missed.
 */
export function foldSearchKey(input: string): string {
  return lemmaKeyOf(input)
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

/** Generic diacritic folding, for Latin loanwords and accented English input. */
export function stripDiacritics(input: string): string {
  return nfc(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC");
}

/**
 * Umlaut restoration candidates: ä→a, ö→o, ü→u (and the ae/oe/ue spellings).
 * Used when *generating* German lemma candidates, never for storage.
 */
export function umlautVariants(input: string): string[] {
  const base = nfc(input);
  const pairs: Array<[RegExp, string]> = [
    [/ä/g, "a"],
    [/ö/g, "o"],
    [/ü/g, "u"],
    [/ß/g, "ss"],
    [/ae/g, "a"],
    [/oe/g, "o"],
    [/ue/g, "u"],
  ];
  const out = new Set<string>();
  for (const [re, to] of pairs) {
    if (re.test(base)) out.add(base.replace(re, to));
  }
  return [...out];
}

/** German nouns are capitalised; a capitalised initial is a strong (not certain) noun signal. */
export function looksCapitalised(input: string): boolean {
  const first = nfc(input).charAt(0);
  return first !== "" && first === first.toUpperCase() && first !== first.toLowerCase();
}

/** Foreign-script detection, so we never run a Latin lemmatiser over Han characters. */
export function containsHan(input: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(input);
}
