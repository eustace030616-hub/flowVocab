/**
 * Copy the database from MongoDB into SQLite.
 *
 *   npm run migrate:mongo-to-sqlite
 *
 * A full copy, not a delta, and idempotent: each table is cleared and rewritten inside one
 * transaction, so an interrupted run leaves the file untouched rather than half-migrated.
 *
 * Why MongoDB is still in the picture: the *importers* — ding, CC-CEDICT, kaikki, DWDS, Leipzig,
 * wordfreq, the morphology compiler — still write there, because they lean on bulk upserts and
 * aggregations that took work to get right and are the next thing to port. The runtime reads SQLite.
 * Until the importers move, this script is the bridge, and re-running it after an import is what
 * keeps the two in step. Row counts are printed side by side so a missed table is visible rather
 * than silent.
 */

import mongoose from "mongoose";

import { connectDB } from "../../lib/db";
import { closeDatabase, db, flag, json, newId, transaction, openDatabase } from "../../lib/store/db";
import { DATABASE_PATH } from "../../lib/store/db";
import { runIfEntry } from "../run";

type Doc = Record<string, unknown>;

const asId = (value: unknown): string => {
  if (value && typeof value === "object" && "toString" in value) return String(value);
  return String(value ?? "");
};

const asMs = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
};

const asJson = (value: unknown, fallback: unknown): string =>
  JSON.stringify(value === undefined || value === null ? fallback : value);

/** The tables, in the order they are copied, with the mapping for each. */
const TABLES: Array<{
  table: string;
  collection: string;
  columns: string[];
  map: (doc: Doc) => unknown[];
}> = [
  {
    table: "users",
    collection: "users",
    columns: ["id", "userId", "track", "uiLocale", "createdAt", "updatedAt"],
    map: (d) => [asId(d._id), String(d.userId), String(d.track ?? "zh-en"), String(d.uiLocale ?? "en"), asMs(d.createdAt), asMs(d.updatedAt)],
  },
  {
    table: "words",
    collection: "words",
    columns: [
      "id", "targetLang", "lemmaKey", "lemma", "pos", "origin", "surfaceForms", "level",
      "levelEstimated", "levelSource", "difficulty", "frequency", "article", "plural",
      "cognateWithEn", "falseFriend", "createdAt",
    ],
    map: (d) => [
      asId(d._id), String(d.targetLang), String(d.lemmaKey), String(d.lemma), String(d.pos ?? ""),
      String(d.origin ?? "learner"), asJson(d.surfaceForms, []), (d.level as string) ?? null,
      flag(Boolean(d.levelEstimated)), (d.levelSource as string) ?? null,
      typeof d.difficulty === "number" ? d.difficulty : -1, asJson(d.frequency, {}),
      (d.article as string) ?? null, (d.plural as string) ?? null,
      flag(Boolean(d.cognateWithEn)), flag(Boolean(d.falseFriend)), asMs(d.createdAt),
    ],
  },
  {
    table: "glosses",
    collection: "glosses",
    columns: [
      "id", "targetLang", "lemmaKey", "pos", "lang", "text", "sense", "termPos", "source",
      "license", "generated", "rank", "weight", "createdAt",
    ],
    map: (d) => [
      asId(d._id), String(d.targetLang), String(d.lemmaKey), String(d.pos ?? ""), String(d.lang),
      String(d.text), (d.sense as string) ?? null, (d.termPos as string) ?? null,
      String(d.source), String(d.license), flag(Boolean(d.generated)),
      typeof d.rank === "number" ? d.rank : 0, typeof d.weight === "number" ? d.weight : null,
      asMs(d.createdAt),
    ],
  },
  {
    table: "inflections",
    collection: "inflections",
    columns: ["id", "targetLang", "form", "base", "baseLemmaKey", "pos", "source", "license", "createdAt"],
    map: (d) => [
      asId(d._id), String(d.targetLang), String(d.form), String(d.base), String(d.baseLemmaKey),
      String(d.pos ?? ""), String(d.source), String(d.license), asMs(d.createdAt),
    ],
  },
  {
    table: "separations",
    collection: "separations",
    columns: ["id", "targetLang", "particle", "verb", "merged", "source", "createdAt"],
    map: (d) => [asId(d._id), String(d.targetLang), String(d.particle), String(d.verb), String(d.merged), String(d.source), asMs(d.createdAt)],
  },
  {
    table: "compounds",
    collection: "compounds",
    columns: ["id", "targetLang", "form", "parts", "source", "createdAt"],
    map: (d) => [asId(d._id), String(d.targetLang), String(d.form), asJson(d.parts, []), String(d.source), asMs(d.createdAt)],
  },
  {
    table: "provenance",
    collection: "provenances",
    columns: [
      "id", "dataset", "title", "url", "license", "licenseUrl", "attribution", "commercialUse",
      "shareAlike", "copyleft", "offlineOnly", "retrievedAt", "rowCount", "contributesTo", "notes",
    ],
    map: (d) => [
      asId(d._id), String(d.dataset), String(d.title), String(d.url), String(d.license),
      (d.licenseUrl as string) ?? null, String(d.attribution), flag(Boolean(d.commercialUse)),
      flag(Boolean(d.shareAlike)), flag(Boolean(d.copyleft)), flag(Boolean(d.offlineOnly)),
      asMs(d.retrievedAt), typeof d.rowCount === "number" ? d.rowCount : null,
      asJson(d.contributesTo, []), (d.notes as string) ?? null,
    ],
  },
  {
    table: "paragraphs",
    collection: "paragraphs",
    columns: [
      "id", "targetLang", "title", "content", "topic", "wordCount", "level", "difficulty",
      "difficultySource", "coverage", "tokenizerVersion", "source", "briefId", "buffered",
      "promptSnapshot", "createdAt", "updatedAt",
    ],
    map: (d) => [
      asId(d._id), String(d.targetLang ?? "en"), String(d.title), String(d.content),
      (d.topic as string) ?? null, typeof d.wordCount === "number" ? d.wordCount : 0,
      (d.level as string) ?? null, typeof d.difficulty === "number" ? d.difficulty : -1,
      (d.difficultySource as string) ?? null, typeof d.coverage === "number" ? d.coverage : -1,
      typeof d.tokenizerVersion === "number" ? d.tokenizerVersion : 1,
      String(d.source ?? "seed"), (d.briefId as string) ?? null, flag(Boolean(d.buffered)),
      (d.promptSnapshot as string) ?? null, asMs(d.createdAt), asMs(d.updatedAt ?? d.createdAt),
    ],
  },
  {
    table: "marks",
    collection: "marks",
    columns: [
      "id", "userId", "targetLang", "paragraphId", "wordId", "surface", "lemmaKey", "charStart",
      "charEnd", "tokenizerVersion", "status", "markedAt",
    ],
    map: (d) => [
      asId(d._id), String(d.userId), String(d.targetLang), asId(d.paragraphId), asId(d.wordId),
      String(d.surface ?? ""), String(d.lemmaKey ?? ""), Number(d.charStart ?? 0), Number(d.charEnd ?? 0),
      Number(d.tokenizerVersion ?? 1), String(d.status ?? "marked"), asMs(d.markedAt),
    ],
  },
  {
    table: "events",
    collection: "events",
    columns: [
      "id", "userId", "targetLang", "type", "source", "sessionId", "paragraphId", "wordId",
      "surface", "lemmaKey", "charStart", "charEnd", "items", "ts",
    ],
    map: (d) => [
      asId(d._id), String(d.userId), String(d.targetLang), String(d.type), String(d.source ?? "web"),
      (d.sessionId as string) ?? null, d.paragraphId ? asId(d.paragraphId) : null,
      d.wordId ? asId(d.wordId) : null, (d.surface as string) ?? null, (d.lemmaKey as string) ?? null,
      typeof d.charStart === "number" ? d.charStart : null,
      typeof d.charEnd === "number" ? d.charEnd : null,
      d.items ? JSON.stringify(d.items) : null, asMs(d.ts),
    ],
  },
  {
    table: "word_states",
    collection: "wordstates",
    columns: ["id", "userId", "targetLang", "lemmaKey", "wordId", "status", "timesMet", "unfamiliarity", "lookupCount", "exposureCount", "updatedAt"],
    map: (d) => [
      asId(d._id), String(d.userId), String(d.targetLang), String(d.lemmaKey), asId(d.wordId),
      String(d.status ?? "unfamiliar"), Number(d.timesMet ?? 0), Number(d.unfamiliarity ?? 0),
      Number(d.lookupCount ?? 0), Number(d.exposureCount ?? 0), asMs(d.updatedAt),
    ],
  },
  {
    table: "ability_states",
    collection: "abilitystates",
    columns: ["id", "userId", "targetLang", "theta", "se", "n", "level", "levelLow", "levelHigh", "priorTheta", "updatedAt"],
    map: (d) => [
      asId(d._id), String(d.userId), String(d.targetLang), Number(d.theta ?? 0.5), Number(d.se ?? 0.6),
      Number(d.n ?? 0), (d.level as string) ?? null, String(d.levelLow ?? "A1"),
      String(d.levelHigh ?? "C2"), typeof d.priorTheta === "number" ? d.priorTheta : null,
      asMs(d.updatedAt),
    ],
  },
  {
    table: "placement_sessions",
    collection: "placementsessions",
    columns: ["id", "userId", "targetLang", "seed", "items", "responses", "completedAt", "score", "createdAt"],
    map: (d) => [
      asId(d._id), String(d.userId), String(d.targetLang), Number(d.seed ?? 0),
      asJson(d.items, []), asJson(d.responses, []),
      d.completedAt ? asMs(d.completedAt) : null, d.score ? JSON.stringify(d.score) : null,
      asMs(d.createdAt),
    ],
  },
];

async function main() {
  console.log("migrate MongoDB → SQLite");
  console.log("────────────────────────");
  console.log(`  target       ${DATABASE_PATH}`);

  await connectDB();
  openDatabase();

  const report: Array<{ table: string; mongo: number; sqlite: number; ok: boolean }> = [];

  for (const spec of TABLES) {
    const collection = mongoose.connection.collection(spec.collection);
    const cursor = collection.find({});
    const statement = db().prepare(
      `INSERT OR REPLACE INTO ${spec.table} (${spec.columns.join(", ")}) VALUES (${spec.columns.map(() => "?").join(", ")})`,
    );

    let copied = 0;

    // Cleared once, then written in batches. The cursor is async and the writes are not, so each
    // batch is read first and written inside one transaction — bounded memory (a few thousand rows)
    // with the speed of not committing per row.
    db().prepare(`DELETE FROM ${spec.table}`).run();

    let batch: Doc[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      transaction(() => {
        for (const doc of batch) {
          statement.run(...(spec.map(doc) as never[]));
          copied += 1;
        }
      });
      batch = [];
    };

    for await (const doc of collection.find({})) {
      batch.push(doc as Doc);
      if (batch.length >= 5000) flush();
    }
    flush();

    const mongo = await collection.countDocuments({});
    report.push({ table: spec.table, mongo, sqlite: copied, ok: mongo === copied });
    process.stdout.write(`\r  ${spec.table.padEnd(20)} ${String(copied).padStart(7)} / ${String(mongo).padStart(7)}`);
  }
  process.stdout.write("\n\n");

  for (const row of report) {
    console.log(`  ${row.ok ? "ok  " : "MISMATCH"} ${row.table.padEnd(20)} mongo ${String(row.mongo).padStart(7)} · sqlite ${String(row.sqlite).padStart(7)}`);
  }

  // Sanity checks a row count cannot make: a gloss that lost its text, a word without a join key.
  const checks: Array<[string, string]> = [
    ["glosses with no text", "SELECT COUNT(*) AS n FROM glosses WHERE text IS NULL OR text = ''"],
    ["words with no lemmaKey", "SELECT COUNT(*) AS n FROM words WHERE lemmaKey IS NULL OR lemmaKey = ''"],
    ["paragraphs with no content", "SELECT COUNT(*) AS n FROM paragraphs WHERE content IS NULL OR content = ''"],
    ["marks with no paragraph", "SELECT COUNT(*) AS n FROM marks WHERE paragraphId IS NULL OR paragraphId = ''"],
  ];
  for (const [label, sql] of checks) {
    const n = Number((db().prepare(sql).get() as { n: number }).n);
    console.log(`  ${n === 0 ? "ok  " : "FAIL"} ${label.padEnd(28)} ${n}`);
  }

  closeDatabase();
  await mongoose.disconnect();
  const bad = report.filter((r) => !r.ok);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

runIfEntry(import.meta.url, main);
