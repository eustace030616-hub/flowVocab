/**
 * Import German item difficulty into Word documents.
 *
 *   npm run import:german              DWDS frequency + POS, plus the estimated CEFR prior
 *   npm run import:german -- --with-kaikki   also stream kaikki for article/plural/forms
 *
 * ## Why German is built frequency-first
 *
 * German has no CEFR-J equivalent, and the anchor layer everyone assumes exists mostly does not:
 *
 *   A1/A2/B1  Goethe wordlists exist — but the PDFs forbid saving, redistribution and network
 *             distribution (explicitly including intranets), so they are offline-only anchors.
 *   B2        no free official list; the real one is inside a commercial Hueber book.
 *   C1/C2     do not exist at all. No Goethe, telc, ÖSD or BAMF list was ever published.
 *
 * So difficulty comes from corpus frequency, and the CEFR label is an *estimate* above A2 that
 * the app has to present as one. Two independent frequency sources are carried (DWDS and
 * Leipzig) so their agreement can be used as a confidence signal; they are not calibrated to
 * each other and are never averaged.
 *
 * Everything here uses shippable datasets. `assertShippable` makes a misconfiguration fail loudly
 * rather than quietly writing Goethe data into the database.
 */

import { createGunzip } from "node:zlib";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Provenance } from "../../models/Provenance";
import { provenanceDocs } from "../../lib/licence";
import { assertShippable, DATASETS } from "../../lib/licence/datasets";
import { isCefrLevel, type CefrLevel } from "../../lib/lang";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { parseCsv } from "./profiles";
import { runIfEntry } from "../run";

const DATA = path.join(process.cwd(), "data", "de");
const DWDS_PATH = path.join(DATA, "dwds-lemmata.csv");
const PH98_PATH = path.join(DATA, "ph98-german-cefr-wordlist.json");
const KAIKKI_PATH = path.join(DATA, "kaikki-de.jsonl.gz");
const LEIPZIG_PATH = path.join(DATA, "leipzig-deu_news_2024_1M.tar.gz");

const DWDS_SOURCE = "dwds-lemmadatenbank";
const PH98_SOURCE = "ph98-german-cefr-wordlist";
const KAIKKI_SOURCE = "kaikki-wiktextract-de";
const LEIPZIG_SOURCE = "leipzig-corpora";

/** DWDS `wortklasse` → our pos code. Unmapped values keep their raw label, lowercased. */
const POS_MAP: Record<string, string> = {
  Substantiv: "noun",
  Verb: "verb",
  Adjektiv: "adjective",
  "partizipiales Adjektiv": "adjective",
  Adverb: "adverb",
  Mehrwortausdruck: "mwe",
  Affix: "affix",
  Präposition: "preposition",
  Konjunktion: "conjunction",
  Pronomen: "pronoun",
  Artikel: "article",
  Interjektion: "interjection",
  Partikel: "particle",
  Numerale: "numeral",
};

export interface GermanRow {
  lemma: string;
  lemmaKey: string;
  pos: string;
  dwdsFrequencyClass?: number;
  level: CefrLevel | null;
  levelEstimated: boolean;
  levelSource: string | null;
  difficulty: number;
}

/**
 * Parse the DWDS lemma database.
 *
 * Symbol entries (`%`, `‰`, `∀`) are excluded: they are real DWDS lemmas but not learnable
 * vocabulary, and including them would inflate every count.
 */
export function parseDwdsCsv(text: string): Array<{
  lemma: string;
  lemmaKey: string;
  pos: string;
  frequencyClass?: number;
}> {
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  const idx = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const iLemma = idx("lemma");
  const iWortklasse = idx("wortklasse");
  const iFreq = idx("frequenzklasse");
  if (iLemma < 0) throw new Error("DWDS CSV: no 'lemma' column");

  const out: Array<{ lemma: string; lemmaKey: string; pos: string; frequencyClass?: number }> = [];
  for (const cells of body) {
    const lemma = (cells[iLemma] ?? "").trim();
    if (!lemma || !/\p{L}/u.test(lemma)) continue;

    const wortklasse = (cells[iWortklasse] ?? "").trim();
    const rawFreq = (cells[iFreq] ?? "").trim();
    const parsed = Number.parseInt(rawFreq, 10);
    const frequencyClass = Number.isFinite(parsed) && parsed >= 0 && parsed <= 6 ? parsed : undefined;

    out.push({
      lemma,
      lemmaKey: lemmaKeyOf(lemma),
      pos: POS_MAP[wortklasse] ?? wortklasse.toLowerCase(),
      frequencyClass,
    });
  }
  return out;
}

/** Parse the ph98 CEFR list. Levels are LLM-assigned — always flagged as estimated. */
export function parsePh98(json: string): Map<string, CefrLevel> {
  const parsed: unknown = JSON.parse(json);
  const levels = new Map<string, CefrLevel>();
  if (!Array.isArray(parsed)) return levels;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { word, level } = entry as { word?: unknown; level?: unknown };
    if (typeof word !== "string" || !isCefrLevel(level)) continue;
    const key = lemmaKeyOf(word);
    if (!levels.has(key)) levels.set(key, level);
  }
  return levels;
}

/**
 * Difficulty in [0,1].
 *
 * From the DWDS Häufigkeitsklasse when present, else from the ph98 level, else unknown (-1).
 *
 * ## Direction of the DWDS scale
 *
 * Higher class means MORE frequent, so difficulty is `1 - class/6`. This was originally written
 * the other way round, which made *Haus* (class 5) hard and *Aalreuse* (class 0) easy — the whole
 * German ladder upside down. Verified empirically against the corpus:
 *
 *     Aalreuse 0   Eiche 3   Gift 3   Wortschatz 2   Baum 4   Wasser 4   Haus 5
 *     wordfreq Zipf: Haus 5.41 > Gift 4.02 > Wortschatz 3.60   (same order)
 *
 * Deliberately coarse: only seven buckets, and **112,492 of the 236,242 classed lemmas sit in
 * class 0** — the rare tail, undifferentiated. So DWDS says almost nothing about exactly the
 * words a learner is heading towards. A Leipzig rank splits that tail; until then, German
 * difficulty should be trusted to pick a *band*, not a specific next word.
 */
export function difficultyForRow(row: {
  dwdsFrequencyClass?: number;
  level: CefrLevel | null;
}): number {
  if (typeof row.dwdsFrequencyClass === "number") {
    return 1 - row.dwdsFrequencyClass / 6;
  }
  if (row.level) {
    const order: CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
    return (order.indexOf(row.level) + 0.5) / order.length;
  }
  return -1;
}

export function buildGermanRows(
  dwds: Array<{ lemma: string; lemmaKey: string; pos: string; frequencyClass?: number }>,
  ph98Levels: Map<string, CefrLevel>,
): GermanRow[] {
  return dwds.map((row) => {
    const level = ph98Levels.get(row.lemmaKey) ?? null;
    return {
      lemma: row.lemma,
      lemmaKey: row.lemmaKey,
      pos: row.pos,
      dwdsFrequencyClass: row.frequencyClass,
      level,
      // ph98 is an LLM-assigned prior. A level from it is never a fact.
      levelEstimated: level !== null,
      levelSource: level !== null ? PH98_SOURCE : null,
      difficulty: difficultyForRow({ dwdsFrequencyClass: row.frequencyClass, level }),
    };
  });
}

/**
 * Stream kaikki German for article, plural and inflected forms.
 *
 * Gender lives in the head template's first argument (e.g. `{"1":"n,-,-:s"}` → neuter with the
 * genitive/plural pattern; the `expansion` field spells it out in prose). Declension tables are
 * template-generated entries in `forms` carrying `de-ndecl` as the inflection template.
 *
 * Streams rather than loads: the file is ~294 MB gzipped.
 */
async function loadKaikkiForms(
  wanted: Set<string>,
  onProgress?: (n: number) => void,
): Promise<Map<string, { article?: string; plural?: string; forms: string[] }>> {
  const out = new Map<string, { article?: string; plural?: string; forms: string[] }>();
  const stream = createReadStream(KAIKKI_PATH).pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let seen = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    seen += 1;
    if (seen % 50_000 === 0) onProgress?.(seen);

    let entry: {
      word?: unknown;
      pos?: unknown;
      head_templates?: Array<{ args?: Record<string, string>; expansion?: string }>;
      forms?: Array<{ form?: string; tags?: string[]; source?: string }>;
      senses?: Array<{ glosses?: string[] }>;
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const word = typeof entry.word === "string" ? entry.word : "";
    if (!word) continue;
    const key = lemmaKeyOf(word);
    if (!wanted.has(key)) continue;

    const record = out.get(key) ?? { forms: [] };

    if (entry.pos === "noun") {
      const expansion = entry.head_templates?.[0]?.expansion ?? "";
      // "April n (strong, genitive April or Aprils, plural Aprile)" → "n"
      const gender = /\b([mnf])\b/.exec(expansion)?.[1];
      if (gender && !record.article) {
        record.article = gender === "m" ? "der" : gender === "f" ? "die" : "das";
      }
      const plural = entry.forms?.find(
        (f) => f.source === "declension" && f.tags?.includes("plural") && f.tags?.includes("nominative"),
      );
      if (plural?.form && !record.plural) record.plural = plural.form;
    }

    for (const form of entry.forms ?? []) {
      if (form.form && !record.forms.includes(form.form)) record.forms.push(form.form);
    }

    out.set(key, record);
  }

  return out;
}

async function main() {
  const withKaikki = process.argv.includes("--with-kaikki");

  const dwdsSpec = assertShippable(DWDS_SOURCE);
  const ph98Spec = assertShippable(PH98_SOURCE);

  if (!existsSync(DWDS_PATH)) {
    throw new Error(`missing ${DWDS_PATH}\nRun: npm run fetch:data`);
  }

  console.log("German import");
  console.log("─────────────");

  const dwds = parseDwdsCsv(readFileSync(DWDS_PATH, "utf8"));
  console.log(`  DWDS rows (letters only)    ${dwds.length}`);
  console.log(`  DWDS with frequency class   ${dwds.filter((r) => r.frequencyClass !== undefined).length}`);

  const ph98Levels = existsSync(PH98_PATH) ? parsePh98(readFileSync(PH98_PATH, "utf8")) : new Map();
  console.log(`  ph98 estimated levels       ${ph98Levels.size} (all flagged levelEstimated)`);

  const rows = buildGermanRows(dwds, ph98Levels);
  const levelHistogram: Record<string, number> = {};
  for (const row of rows) {
    const key = row.level ?? "none";
    levelHistogram[key] = (levelHistogram[key] ?? 0) + 1;
  }
  console.log(`  rows with an estimated level ${JSON.stringify(levelHistogram)}`);
  console.log(`  NO official German C1/C2 vocabulary list exists — every label above A2 is an estimate.`);

  await connectDB();

  const ops = rows.map((row) => ({
    updateOne: {
      filter: { targetLang: "de" as const, lemmaKey: row.lemmaKey, pos: row.pos },
      update: {
        $set: {
          // Present in a dataset, so it is a dictionary entry and may inform tokenization.
          origin: "import" as const,
          lemma: row.lemma,
          level: row.level,
          levelEstimated: row.levelEstimated,
          levelSource: row.levelSource,
          difficulty: row.difficulty,
          ...(row.dwdsFrequencyClass !== undefined
            ? { "frequency.dwds": row.dwdsFrequencyClass }
            : {}),
        },
        $setOnInsert: {
          targetLang: "de" as const,
          lemmaKey: row.lemmaKey,
          pos: row.pos,
          surfaceForms: [],
        },
      },
      upsert: true,
    },
  }));

  const BATCH = 1000;
  for (let i = 0; i < ops.length; i += BATCH) {
    await Word.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    process.stdout.write(`\r  writing… ${Math.min(i + BATCH, ops.length)}/${ops.length}`);
  }
  process.stdout.write("\n");

  if (withKaikki) {
    if (!existsSync(KAIKKI_PATH)) {
      console.log(`  kaikki not found at ${KAIKKI_PATH} — run: ./src/scripts/import/fetch-data.sh --full`);
    } else {
      console.log("  streaming kaikki for article/plural/forms…");
      const wanted = new Set(rows.map((r) => r.lemmaKey));
      const forms = await loadKaikkiForms(wanted, (n) =>
        process.stdout.write(`\r  kaikki lines… ${n.toLocaleString()}`),
      );
      process.stdout.write("\n");
      console.log(`  kaikki entries matched      ${forms.size} of ${wanted.size} lemmas`);

      const formOps = [...forms.entries()].map(([lemmaKey, record]) => ({
        updateOne: {
          filter: { targetLang: "de" as const, lemmaKey },
          update: {
            $set: {
              ...(record.article ? { article: record.article } : {}),
              ...(record.plural ? { plural: record.plural } : {}),
              surfaceForms: record.forms.slice(0, 64),
            },
          },
        },
      }));
      for (let i = 0; i < formOps.length; i += BATCH) {
        await Word.bulkWrite(formOps.slice(i, i + BATCH), { ordered: false });
      }
      console.log(`  morphology updated          ${formOps.length}`);
    }
  } else {
    console.log("  kaikki morphology skipped (pass --with-kaikki for article/plural/forms)");
  }

  if (existsSync(LEIPZIG_PATH)) {
    console.log("  Leipzig archive present — rank extraction is a Phase 1 task");
  }

  await Provenance.deleteMany({ dataset: { $in: [DWDS_SOURCE, PH98_SOURCE] } });
  await Provenance.insertMany(
    provenanceDocs().filter((d) => [DWDS_SOURCE, PH98_SOURCE].includes(d.dataset)),
  );

  console.log(`\n  DWDS licence                ${dwdsSpec.license} (commercial: ${dwdsSpec.commercialUse})`);
  console.log(`  ph98 licence                ${ph98Spec.license}`);
  console.log(`  offline-only datasets used  none (${Object.values(DATASETS).filter((d) => d.offlineOnly).length} exist and are excluded)`);
}

runIfEntry(import.meta.url, main);
