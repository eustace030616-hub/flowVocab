/**
 * The dictionary side of the store: words, their translations, and the compiled morphology.
 *
 * These are the read-mostly tables. The reader hits them on every paragraph — a word by its join key,
 * its glosses by the same key, a stated inflection or compound split — so the queries here are keyed
 * lookups and nothing more elaborate.
 */

import { all, bool, flag, get, json, newId, nowMs, placeholders, run, transaction } from "./db";

export interface WordRecord {
  _id: string;
  targetLang: "en" | "de";
  lemmaKey: string;
  lemma: string;
  pos: string;
  origin: "import" | "learner";
  surfaceForms: string[];
  level: string | null;
  levelEstimated: boolean;
  levelSource: string | null;
  difficulty: number;
  frequency: { wordfreq?: number; dwds?: number; leipzig?: number };
  article?: string | null;
  plural?: string | null;
  cognateWithEn?: boolean;
  falseFriend?: boolean;
  createdAt?: number;
}

export interface GlossRecord {
  _id: string;
  targetLang: "en" | "de";
  lemmaKey: string;
  pos: string;
  lang: "en" | "zh";
  text: string;
  sense?: string | null;
  termPos?: string | null;
  source: string;
  license: string;
  generated: boolean;
  rank: number;
  weight?: number | null;
}

export interface InflectionRecord {
  _id: string;
  targetLang: "en" | "de";
  form: string;
  base: string;
  baseLemmaKey: string;
  pos: string;
  source: string;
  license: string;
}

export interface SeparationRecord {
  _id: string;
  targetLang: "en" | "de";
  particle: string;
  verb: string;
  merged: string;
  source: string;
}

export interface CompoundRecord {
  _id: string;
  targetLang: "en" | "de";
  form: string;
  parts: string[];
  source: string;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface WordRow {
  id: string;
  targetLang: string;
  lemmaKey: string;
  lemma: string;
  pos: string;
  origin: string;
  surfaceForms: string;
  level: string | null;
  levelEstimated: number;
  levelSource: string | null;
  difficulty: number;
  frequency: string;
  article: string | null;
  plural: string | null;
  cognateWithEn: number;
  falseFriend: number;
  createdAt: number;
}

export function toWord(row: WordRow): WordRecord {
  return {
    _id: row.id,
    targetLang: row.targetLang as "en" | "de",
    lemmaKey: row.lemmaKey,
    lemma: row.lemma,
    pos: row.pos,
    origin: row.origin as "import" | "learner",
    surfaceForms: json<string[]>(row.surfaceForms, []),
    level: row.level,
    levelEstimated: bool(row.levelEstimated),
    levelSource: row.levelSource,
    difficulty: row.difficulty,
    frequency: json<WordRecord["frequency"]>(row.frequency, {}),
    article: row.article,
    plural: row.plural,
    cognateWithEn: bool(row.cognateWithEn),
    falseFriend: bool(row.falseFriend),
    createdAt: row.createdAt,
  };
}

interface GlossRow {
  id: string;
  targetLang: string;
  lemmaKey: string;
  pos: string;
  lang: string;
  text: string;
  sense: string | null;
  termPos: string | null;
  source: string;
  license: string;
  generated: number;
  rank: number;
  weight: number | null;
}

export function toGloss(row: GlossRow): GlossRecord {
  return {
    _id: row.id,
    targetLang: row.targetLang as "en" | "de",
    lemmaKey: row.lemmaKey,
    pos: row.pos,
    lang: row.lang as "en" | "zh",
    text: row.text,
    sense: row.sense,
    termPos: row.termPos,
    source: row.source,
    license: row.license,
    generated: bool(row.generated),
    rank: row.rank,
    weight: row.weight,
  };
}

// ── Words ─────────────────────────────────────────────────────────────────────

/**
 * Words for a set of join keys.
 *
 * `origin` defaults to the dataset entries only: a word the learner marked is created on the spot,
 * and letting those into the tokenizer's lexicon would make any marked word look like a dictionary
 * headword.
 */
export function wordsByKeys(
  targetLang: string,
  keys: string[],
  options: { origin?: string | null } = {},
): WordRecord[] {
  if (keys.length === 0) return [];
  const origin = options.origin === undefined ? "import" : options.origin;
  const rows = origin
    ? all<WordRow>(
        `SELECT * FROM words WHERE targetLang = ? AND origin = ? AND lemmaKey IN (${placeholders(keys.length)})`,
        targetLang,
        origin,
        ...keys,
      )
    : all<WordRow>(
        `SELECT * FROM words WHERE targetLang = ? AND lemmaKey IN (${placeholders(keys.length)})`,
        targetLang,
        ...keys,
      );
  return rows.map(toWord);
}

export function wordsByLemma(targetLang: string, lemmaKey: string): WordRecord[] {
  return all<WordRow>("SELECT * FROM words WHERE targetLang = ? AND lemmaKey = ? LIMIT 5", targetLang, lemmaKey).map(toWord);
}

export function wordByIdentity(targetLang: string, lemmaKey: string, pos: string): WordRecord | null {
  const row = get<WordRow>(
    "SELECT * FROM words WHERE targetLang = ? AND lemmaKey = ? AND pos = ?",
    targetLang,
    lemmaKey,
    pos,
  );
  return row ? toWord(row) : null;
}

export function wordById(id: string): WordRecord | null {
  const row = get<WordRow>("SELECT * FROM words WHERE id = ?", id);
  return row ? toWord(row) : null;
}

/** Insert unless the identity already exists, in which case return what is there. */
export function ensureWord(word: Omit<WordRecord, "_id"> & { _id?: string }): WordRecord {
  const existing = wordByIdentity(word.targetLang, word.lemmaKey, word.pos);
  if (existing) return existing;

  const id = word._id ?? newId();
  run(
    `INSERT INTO words (id, targetLang, lemmaKey, lemma, pos, origin, surfaceForms, level, levelEstimated,
                        levelSource, difficulty, frequency, article, plural, cognateWithEn, falseFriend, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    word.targetLang,
    word.lemmaKey,
    word.lemma,
    word.pos,
    word.origin,
    JSON.stringify(word.surfaceForms ?? []),
    word.level ?? null,
    flag(word.levelEstimated),
    word.levelSource ?? null,
    word.difficulty ?? -1,
    JSON.stringify(word.frequency ?? {}),
    word.article ?? null,
    word.plural ?? null,
    flag(word.cognateWithEn),
    flag(word.falseFriend),
    nowMs(),
  );
  return { ...word, _id: id };
}

/**
 * Upsert a dataset word by its identity.
 *
 * `$setOnInsert` semantics for `surfaceForms`: forms accumulate across imports, they are not replaced
 * by whichever import ran last.
 */
export function upsertImportedWord(word: Omit<WordRecord, "_id"> & { _id?: string }): string {
  const id = word._id ?? newId();
  run(
    `INSERT INTO words (id, targetLang, lemmaKey, lemma, pos, origin, surfaceForms, level, levelEstimated,
                        levelSource, difficulty, frequency, article, plural, cognateWithEn, falseFriend, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(targetLang, lemmaKey, pos) DO UPDATE SET
       lemma = excluded.lemma,
       origin = excluded.origin,
       level = excluded.level,
       levelEstimated = excluded.levelEstimated,
       levelSource = excluded.levelSource,
       difficulty = excluded.difficulty,
       frequency = excluded.frequency,
       article = COALESCE(excluded.article, words.article),
       plural = COALESCE(excluded.plural, words.plural),
       cognateWithEn = excluded.cognateWithEn,
       falseFriend = excluded.falseFriend,
       surfaceForms = (
         SELECT json_group_array(DISTINCT value) FROM (
           SELECT value FROM json_each(words.surfaceForms)
           UNION SELECT value FROM json_each(excluded.surfaceForms)
         )
       )`,
    id,
    word.targetLang,
    word.lemmaKey,
    word.lemma,
    word.pos,
    word.origin,
    JSON.stringify(word.surfaceForms ?? []),
    word.level ?? null,
    flag(word.levelEstimated),
    word.levelSource ?? null,
    word.difficulty ?? -1,
    JSON.stringify(word.frequency ?? {}),
    word.article ?? null,
    word.plural ?? null,
    flag(word.cognateWithEn),
    flag(word.falseFriend),
    nowMs(),
  );
  return id;
}

export function addSurfaceForm(id: string, form: string): void {
  run(
    `UPDATE words SET surfaceForms = (
       SELECT json_group_array(DISTINCT value) FROM (
         SELECT value FROM json_each(words.surfaceForms) UNION SELECT ?
       )
     ) WHERE id = ?`,
    form,
    id,
  );
}

export function countWords(targetLang: string, origin = "import"): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM words WHERE targetLang = ? AND origin = ?", targetLang, origin)?.n ?? 0);
}

// ── Glosses ───────────────────────────────────────────────────────────────────

/**
 * Glosses for a set of keys, best first.
 *
 * Order is `rank, source, text` — the same cross-source preference the documents used: curated
 * content claims 0, imported dictionaries start at 1, gap-fillers later, and the source breaks ties
 * so the result does not depend on insertion order.
 */
export function glossesByKeys(targetLang: string, lang: string, keys: string[]): GlossRecord[] {
  if (keys.length === 0) return [];
  return all<GlossRow>(
    `SELECT * FROM glosses WHERE targetLang = ? AND lang = ? AND lemmaKey IN (${placeholders(keys.length)})
     ORDER BY rank ASC, source ASC, text ASC`,
    targetLang,
    lang,
    ...keys,
  ).map(toGloss);
}

export function glossKeys(targetLang: string, lang: string, keys: string[]): Set<string> {
  if (keys.length === 0) return new Set();
  const rows = all<{ lemmaKey: string }>(
    `SELECT DISTINCT lemmaKey FROM glosses WHERE targetLang = ? AND lang = ? AND lemmaKey IN (${placeholders(keys.length)})`,
    targetLang,
    lang,
    ...keys,
  );
  return new Set(rows.map((row) => row.lemmaKey));
}

export function countGlossedWords(targetLang: string, lang: string): number {
  return Number(
    get<{ n: number }>("SELECT COUNT(DISTINCT lemmaKey) AS n FROM glosses WHERE targetLang = ? AND lang = ?", targetLang, lang)?.n ?? 0,
  );
}

export function upsertGloss(gloss: Omit<GlossRecord, "_id">): void {
  run(
    `INSERT INTO glosses (id, targetLang, lemmaKey, pos, lang, text, sense, termPos, source, license, generated, rank, weight, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(targetLang, lemmaKey, pos, lang, source, text) DO UPDATE SET
       termPos = excluded.termPos, rank = excluded.rank, weight = excluded.weight, generated = excluded.generated`,
    newId(),
    gloss.targetLang,
    gloss.lemmaKey,
    gloss.pos,
    gloss.lang,
    gloss.text,
    gloss.sense ?? null,
    gloss.termPos ?? null,
    gloss.source,
    gloss.license,
    flag(gloss.generated),
    gloss.rank,
    gloss.weight ?? null,
    nowMs(),
  );
}

export function deleteGlossesBySource(source: string): number {
  const before = Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM glosses WHERE source = ?", source)?.n ?? 0);
  run("DELETE FROM glosses WHERE source = ?", source);
  return before;
}

export function deleteWordsBySources(sources: string[]): void {
  if (sources.length === 0) return;
  run(`DELETE FROM glosses WHERE source IN (${placeholders(sources.length)})`, ...sources);
}

// ── Compiled morphology ───────────────────────────────────────────────────────

export function inflectionsByForm(targetLang: string, forms: string[]): InflectionRecord[] {
  if (forms.length === 0) return [];
  return all<InflectionRecord & { id: string }>(
    `SELECT id AS _id, targetLang, form, base, baseLemmaKey, pos, source, license
     FROM inflections WHERE targetLang = ? AND form IN (${placeholders(forms.length)})`,
    targetLang,
    ...forms,
  );
}

export function separationsByParticle(targetLang: string, particles: string[]): SeparationRecord[] {
  if (particles.length === 0) return [];
  return all<SeparationRecord & { id: string }>(
    `SELECT id AS _id, targetLang, particle, verb, merged, source
     FROM separations WHERE targetLang = ? AND particle IN (${placeholders(particles.length)})`,
    targetLang,
    ...particles,
  );
}

export function compoundsByForm(targetLang: string, forms: string[]): CompoundRecord[] {
  if (forms.length === 0) return [];
  return all<{ id: string; targetLang: string; form: string; parts: string; source: string }>(
    `SELECT id, targetLang, form, parts, source FROM compounds WHERE targetLang = ? AND form IN (${placeholders(forms.length)})`,
    targetLang,
    ...forms,
  ).map((row) => ({
    _id: row.id,
    targetLang: row.targetLang as "en" | "de",
    form: row.form,
    parts: json<string[]>(row.parts, []),
    source: row.source,
  }));
}

export function countSeparations(targetLang: string): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM separations WHERE targetLang = ?", targetLang)?.n ?? 0);
}

export function countCompounds(targetLang: string): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM compounds WHERE targetLang = ?", targetLang)?.n ?? 0);
}

export function countInflections(targetLang: string): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM inflections WHERE targetLang = ?", targetLang)?.n ?? 0);
}

export function upsertInflection(row: Omit<InflectionRecord, "_id">): void {
  run(
    `INSERT INTO inflections (id, targetLang, form, base, baseLemmaKey, pos, source, license)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(targetLang, form, baseLemmaKey, pos, source) DO UPDATE SET base = excluded.base`,
    newId(),
    row.targetLang,
    row.form,
    row.base,
    row.baseLemmaKey,
    row.pos,
    row.source,
    row.license,
  );
}

export function deleteInflectionsBySource(source: string): void {
  run("DELETE FROM inflections WHERE source = ?", source);
}

export function replaceSeparations(targetLang: string, rows: Array<Omit<SeparationRecord, "_id">>): void {
  transaction(() => {
    run("DELETE FROM separations WHERE targetLang = ?", targetLang);
    for (const row of rows) {
      run(
        `INSERT INTO separations (id, targetLang, particle, verb, merged, source) VALUES (?,?,?,?,?,?)
         ON CONFLICT(targetLang, particle, verb) DO UPDATE SET merged = excluded.merged`,
        newId(),
        row.targetLang,
        row.particle,
        row.verb,
        row.merged,
        row.source,
      );
    }
  });
}

export function replaceCompounds(targetLang: string, rows: Array<Omit<CompoundRecord, "_id">>): void {
  transaction(() => {
    run("DELETE FROM compounds WHERE targetLang = ?", targetLang);
    for (const row of rows) {
      run(
        `INSERT INTO compounds (id, targetLang, form, parts, source) VALUES (?,?,?,?,?)
         ON CONFLICT(targetLang, form) DO UPDATE SET parts = excluded.parts`,
        newId(),
        row.targetLang,
        row.form,
        JSON.stringify(row.parts),
        row.source,
      );
    }
  });
}

// ── Provenance ────────────────────────────────────────────────────────────────

export interface ProvenanceRecord {
  dataset: string;
  title: string;
  url: string;
  license: string;
  licenseUrl?: string | null;
  attribution: string;
  commercialUse: boolean;
  shareAlike: boolean;
  copyleft: boolean;
  offlineOnly: boolean;
  rowCount?: number | null;
  contributesTo: string[];
  notes?: string | null;
}

export function provenanceByDataset(dataset: string): ProvenanceRecord | null {
  const row = get<Record<string, unknown>>("SELECT * FROM provenance WHERE dataset = ?", dataset);
  if (!row) return null;
  return {
    dataset: String(row.dataset),
    title: String(row.title),
    url: String(row.url),
    license: String(row.license),
    licenseUrl: (row.licenseUrl as string) ?? null,
    attribution: String(row.attribution),
    commercialUse: bool(row.commercialUse),
    shareAlike: bool(row.shareAlike),
    copyleft: bool(row.copyleft),
    offlineOnly: bool(row.offlineOnly),
    rowCount: (row.rowCount as number) ?? null,
    contributesTo: json<string[]>(row.contributesTo as string, []),
    notes: (row.notes as string) ?? null,
  };
}

export function allProvenance(): ProvenanceRecord[] {
  return all<Record<string, unknown>>("SELECT * FROM provenance ORDER BY dataset ASC").map((row) => ({
    dataset: String(row.dataset),
    title: String(row.title),
    url: String(row.url),
    license: String(row.license),
    licenseUrl: (row.licenseUrl as string) ?? null,
    attribution: String(row.attribution),
    commercialUse: bool(row.commercialUse),
    shareAlike: bool(row.shareAlike),
    copyleft: bool(row.copyleft),
    offlineOnly: bool(row.offlineOnly),
    rowCount: (row.rowCount as number) ?? null,
    contributesTo: json<string[]>(row.contributesTo as string, []),
    notes: (row.notes as string) ?? null,
  }));
}

export function upsertProvenance(row: ProvenanceRecord): void {
  run(
    `INSERT INTO provenance (id, dataset, title, url, license, licenseUrl, attribution, commercialUse,
                             shareAlike, copyleft, offlineOnly, retrievedAt, rowCount, contributesTo, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET
       title = excluded.title, url = excluded.url, license = excluded.license,
       licenseUrl = excluded.licenseUrl, attribution = excluded.attribution,
       commercialUse = excluded.commercialUse, shareAlike = excluded.shareAlike,
       copyleft = excluded.copyleft, offlineOnly = excluded.offlineOnly,
       rowCount = excluded.rowCount, contributesTo = excluded.contributesTo, notes = excluded.notes`,
    newId(),
    row.dataset,
    row.title,
    row.url,
    row.license,
    row.licenseUrl ?? null,
    row.attribution,
    flag(row.commercialUse),
    flag(row.shareAlike),
    flag(row.copyleft),
    flag(row.offlineOnly),
    nowMs(),
    row.rowCount ?? null,
    JSON.stringify(row.contributesTo),
    row.notes ?? null,
  );
}
