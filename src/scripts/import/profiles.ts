/**
 * English CEFR profile parsing and merging — pure, no filesystem and no database, so the
 * merge can be tested against the real source files without a Mongo instance.
 *
 * ## The bug this module exists to fix
 *
 * The original pipeline (`merge_csv.py`, April 2025) read both source CSVs and then deduped
 * on `word.lower()`:
 *
 *     word_key = w["word"].lower()
 *     if word_key not in all_words: all_words[word_key] = w
 *
 * That collapses every part-of-speech reading of a headword into one row — *run* the noun and
 * *run* the verb become a single entry — and it also picks one level when a headword is listed
 * at two levels. Measured against the real sources, it dropped **1,126 rows (11.5%)**:
 *
 *     source rows (CEFR-J 7,799 + Octanove 2,136)     9,935
 *     genuine (lemma, pos) duplicates                   -156
 *       of which: 1 within CEFR-J, 60 within Octanove, 95 across the two sources
 *     ─────────────────────────────────────────────────────
 *     correct merged rows (lemma, pos)                 9,779
 *     legacy headword-only merge                       8,653  ← what actually shipped
 *     ─────────────────────────────────────────────────────
 *     rows recovered by keeping POS                    1,126
 *
 * The legacy number is reproducible from this module by keying on the headword alone, which is
 * what `tests/import.test.ts` asserts — that is the proof of diagnosis, not just a claim.
 *
 * Part of speech is exactly the dimension item difficulty needs, so the merge key here is
 * (lemma, pos), not the spelling alone.
 */

import type { CefrLevel } from "../../lib/lang";
import { isCefrLevel } from "../../lib/lang";
import { lemmaKeyOf, nfc } from "../../lib/tokenize/normalize";

export interface ProfileRow {
  headword: string;
  pos: string;
  level: CefrLevel;
  source: string;
}

export interface MergedWord {
  lemma: string;
  lemmaKey: string;
  pos: string;
  level: CefrLevel;
  /** True when the level is inferred rather than read from a labelled row. */
  levelEstimated: boolean;
  levelSource: string;
  /** Every dataset that contributed a row for this (lemma, pos). */
  sources: string[];
  /** All levels seen across sources, for auditing disagreements. */
  levelsSeen: CefrLevel[];
}

export const CEFRJ_SOURCE = "cefrj-vocabulary-profile-1.5";
export const OCTANOVE_SOURCE = "octanove-vocabulary-profile-c1c2-1.0";

/**
 * Minimal RFC-4180-ish CSV parser: handle quoted fields, embedded commas and escaped quotes.
 * Small enough to own, so the importer has no dependency that could change parsing silently.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM if present.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface ParsedCsv {
  header: string[];
  rows: Array<Record<string, string>>;
}

function parseWithHeader(text: string): ParsedCsv {
  const raw = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const [header, ...body] = raw;
  if (!header) return { header: [], rows: [] };

  const normalisedHeader = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows = body.map((cells) => {
    const obj: Record<string, string> = {};
    normalisedHeader.forEach((key, idx) => {
      obj[key] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
  return { header: normalisedHeader, rows };
}

function rowToProfile(
  row: Record<string, string>,
  source: string,
): ProfileRow | null {
  const headword = nfc(row.headword || row.word || "");
  const rawLevel = (row.cefr || row.level || "").toUpperCase();
  if (!headword) return null;
  if (!isCefrLevel(rawLevel)) return null;
  return {
    headword,
    pos: (row.pos || "").trim().toLowerCase(),
    level: rawLevel,
    source,
  };
}

export function parseCefrjCsv(text: string): ProfileRow[] {
  const { rows } = parseWithHeader(text);
  return rows
    .map((r) => rowToProfile(r, CEFRJ_SOURCE))
    .filter((r): r is ProfileRow => r !== null);
}

export function parseOctanoveCsv(text: string): ProfileRow[] {
  const { rows } = parseWithHeader(text);
  return rows
    .map((r) => rowToProfile(r, OCTANOVE_SOURCE))
    .filter((r): r is ProfileRow => r !== null);
}

/** Merge key: (lemma, pos). The language is added by the caller, being constant here. */
export function mergeKey(lemmaKey: string, pos: string): string {
  return `${lemmaKey}\u0000${pos}`;
}

const LEVEL_ORDER: CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

/**
 * Merge rows on (lemma, pos).
 *
 * Where sources disagree about a level, the *lower* level wins and both are recorded in
 * `levelsSeen`. Rationale: CEFR-J (A1–B2) and Octanove (C1–C2) were built with different
 * judgement standards, and for a learner-facing difficulty ladder it is safer to under-claim
 * than to tell someone a word they know is advanced. Disagreements are kept so the mapping
 * can be audited rather than smoothed away.
 */
export function mergeProfiles(rows: ProfileRow[]): MergedWord[] {
  const byKey = new Map<string, MergedWord>();

  for (const row of rows) {
    const lemmaKey = lemmaKeyOf(row.headword);
    const key = mergeKey(lemmaKey, row.pos);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        lemma: row.headword,
        lemmaKey,
        pos: row.pos,
        level: row.level,
        levelEstimated: false,
        levelSource: row.source,
        sources: [row.source],
        levelsSeen: [row.level],
      });
      continue;
    }

    if (!existing.sources.includes(row.source)) existing.sources.push(row.source);
    if (!existing.levelsSeen.includes(row.level)) existing.levelsSeen.push(row.level);

    if (LEVEL_ORDER.indexOf(row.level) < LEVEL_ORDER.indexOf(existing.level)) {
      existing.level = row.level;
      existing.levelSource = row.source;
    }
  }

  return [...byKey.values()];
}

/** Level histogram, keyed A1..C2 — used by the importer for its verification report. */
export function levelHistogram(words: Array<{ level: CefrLevel }>): Record<CefrLevel, number> {
  const out = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0 } as Record<CefrLevel, number>;
  for (const w of words) out[w.level] += 1;
  return out;
}

/**
 * Difficulty in [0,1] from a CEFR level alone.
 *
 * A placeholder until frequency is attached: it maps the six levels onto evenly spaced bands.
 * Within-band resolution is what matters for i+1 — a CEFR level spans ~1,000–2,500 words, so
 * six buckets cannot express "+1". The frequency-based continuous score replaces this.
 */
export function difficultyFromLevel(level: CefrLevel): number {
  const idx = LEVEL_ORDER.indexOf(level);
  return idx < 0 ? -1 : (idx + 0.5) / LEVEL_ORDER.length;
}
