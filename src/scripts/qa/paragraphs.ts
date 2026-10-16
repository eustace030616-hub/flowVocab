/**
 * Headless inspection of every passage the reader can serve.
 *
 *   npm run qa:paragraphs              # inspect what is stored
 *   npm run qa:paragraphs -- --generate 3   # write three first, then inspect
 *   npm run qa:paragraphs -- --json    # machine-readable, for a loop
 *
 * It reads `GET /api/paragraphs/:id` rather than the database, because the question is not whether
 * the data is good but whether *what the reader receives* is: the payload is where a missing
 * translation, an unresolved token or an unfilled field actually reaches the interface. A check
 * against the database would pass while the screen showed nothing.
 *
 * What it looks for, per passage:
 *
 *   translations   every word token resolves to a lemma the glossary can translate
 *   resolution     every word token resolves to something in the lexicon at all
 *   template       the fields the reader renders are present and non-empty
 *   difficulty     the rubric still passes with the current lexicon and glossary
 *
 * Exit code is 1 when anything fails, so it can gate a build.
 */

import { connectDB } from "../../lib/db";
import mongoose from "mongoose";
import { Paragraph } from "../../models/Paragraph";
import { checkParagraph } from "../../lib/content/rubric";
import { tokenizeWithLexicon } from "../../lib/learner/lexicon";
import { Word } from "../../models/Word";
import { Gloss } from "../../models/Gloss";
import { glossLangFor, type CefrLevel, type TargetLang } from "../../lib/lang";
import { runIfEntry } from "../run";

const BASE = process.env.FLOWWING_BASE_URL || "http://localhost:3100";

interface Finding {
  passage: string;
  kind: "unresolved" | "untranslated" | "template" | "difficulty";
  detail: string;
}

interface Row {
  title: string;
  lang: TargetLang;
  level: CefrLevel;
  words: number;
  resolved: number;
  glossed: number;
  coverage: number | null;
  verdict: string;
  template: boolean;
}

/** The reader's payload for one passage, or null when the route cannot produce it. */
async function fetchPayload(id: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${BASE}/api/paragraphs/${id}`);
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

async function main() {
  const asJson = process.argv.includes("--json");
  const generateIndex = process.argv.indexOf("--generate");
  const toGenerate = generateIndex >= 0 ? Number(process.argv[generateIndex + 1] ?? 1) : 0;

  await connectDB();

  if (toGenerate > 0) {
    // Write some first, so the inspection covers fresh output rather than only what happens to be
    // stored from an earlier run.
    const { deepseekProvider } = await import("../generate/provider");
    const { generateOne, importParagraph } = await import("../generate/generate");
    const { onDemandBrief } = await import("../generate/briefs");
    console.log(`  writing ${toGenerate} passage(s) to inspect…`);
    for (let i = 0; i < toGenerate; i += 1) {
      for (const lang of ["de", "en"] as TargetLang[]) {
        const spec = { ...onDemandBrief(lang, "A2"), briefId: `qa:${lang}:${Date.now().toString(36)}:${i}` };
        const outcome = await generateOne(deepseekProvider(), spec, { deadlineMs: 30_000 });
        if (!outcome.passed) {
          console.log(`    ${lang}: rejected — ${outcome.issues[0] ?? "unknown"}`);
          continue;
        }
        await importParagraph(outcome);
        console.log(`    ${lang} ${outcome.title} written in ${outcome.providerCalls} calls`);
      }
    }
  }

  const stored = await Paragraph.find({ source: "agent" })
    .select("_id title targetLang level content")
    .sort({ createdAt: -1 })
    .lean();

  const rows: Row[] = [];
  const findings: Finding[] = [];

  for (const paragraph of stored) {
    const title = String(paragraph.title);
    const lang = paragraph.targetLang as TargetLang;
    const level = (paragraph.level ?? "A2") as CefrLevel;

    const payload = await fetchPayload(String(paragraph._id));
    if (!payload) {
      findings.push({ passage: title, kind: "template", detail: `GET /api/paragraphs/${paragraph._id} did not return a payload` });
      continue;
    }

    const spans = (payload.spans ?? []) as Array<{ kind: string; surface: string; lemmaKey: string; matched: boolean }>;
    const vocabulary = (payload.vocabulary ?? {}) as Record<string, { gloss?: string | null; meanings?: unknown[] }>;
    const coverage = payload.coverage as { coverage: number; verdict: string; measured: boolean } | undefined;

    const words = spans.filter((s) => s.kind === "word");
    const unresolved = [...new Set(words.filter((s) => !s.matched).map((s) => s.surface))];
    const untranslated = [
      ...new Set(
        words
          .filter((s) => {
            const entry = vocabulary[s.lemmaKey];
            return !entry || (!entry.gloss && !(entry.meanings ?? []).length);
          })
          .map((s) => s.surface),
      ),
    ];

    if (unresolved.length) {
      findings.push({ passage: title, kind: "unresolved", detail: `${unresolved.length} word(s) not in the lexicon: ${unresolved.slice(0, 8).join(", ")}` });
    }
    if (untranslated.length) {
      findings.push({ passage: title, kind: "untranslated", detail: `${untranslated.length} word(s) with no translation: ${untranslated.slice(0, 8).join(", ")}` });
    }

    // The fields the reader renders. A missing one is a blank on screen.
    const templateChecks: Array<[string, unknown]> = [
      ["spans", spans.length > 0],
      ["vocabulary", Object.keys(vocabulary).length > 0],
      ["coverage.coverage", typeof coverage?.coverage === "number"],
      ["coverage.verdict", typeof coverage?.verdict === "string"],
      ["marked", typeof payload.marked === "object" && payload.marked !== null],
      ["title", typeof payload.title === "string" && String(payload.title).length > 0],
      ["level", typeof payload.level === "string" && String(payload.level).length > 0],
      ["wordCount", typeof payload.wordCount === "number" && (payload.wordCount as number) > 0],
      ["tokenizerVersion", typeof payload.tokenizerVersion === "number"],
      ["source", payload.source === "agent"],
      ["promptSnapshot", typeof payload.promptSnapshot === "string" && String(payload.promptSnapshot).length > 100],
    ];
    const missing = templateChecks.filter(([, ok]) => !ok).map(([name]) => name);
    if (missing.length) {
      findings.push({ passage: title, kind: "template", detail: `missing or empty: ${missing.join(", ")}` });
    }

    // The same rubric the generator was held to, re-run against the current data.
    const localSpans = await tokenizeWithLexicon(String(paragraph.content), lang);
    const keys = [...new Set(localSpans.filter((s) => s.kind === "word").map((s) => s.lemmaKey))];
    const wordRows = await Word.find({ targetLang: lang, lemmaKey: { $in: keys }, origin: "import" }).select("lemmaKey difficulty").lean();
    const difficultyOf = new Map<string, number>();
    for (const w of wordRows) {
      const current = difficultyOf.get(w.lemmaKey);
      if (current === undefined || w.difficulty < current) difficultyOf.set(w.lemmaKey, w.difficulty);
    }
    const glossKeys = new Set(
      (await Gloss.find({ targetLang: lang, lang: glossLangFor(lang), lemmaKey: { $in: keys } }).select("lemmaKey").lean()).map((g) => g.lemmaKey),
    );
    const verdict = checkParagraph(
      localSpans.map((s) => ({ lemmaKey: s.lemmaKey, kind: s.kind })),
      { level, difficultyOf: (k) => difficultyOf.get(k), hasGloss: (k) => glossKeys.has(k) },
    );
    if (!verdict.passed) {
      findings.push({ passage: title, kind: "difficulty", detail: verdict.issues.join("; ") });
    }

    rows.push({
      title,
      lang,
      level,
      words: words.length,
      resolved: words.length ? 1 - unresolved.length / new Set(words.map((w) => w.surface)).size : 1,
      glossed: words.length ? 1 - untranslated.length / new Set(words.map((w) => w.surface)).size : 1,
      coverage: coverage?.coverage ?? null,
      verdict: coverage?.verdict ?? "—",
      template: missing.length === 0,
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ rows, findings }, null, 2));
  } else {
    console.log("\n  passage                          lang level  words  translated  coverage   template");
    console.log("  " + "─".repeat(84));
    for (const row of rows) {
      console.log(
        `  ${row.title.slice(0, 32).padEnd(33)} ${row.lang.padEnd(4)} ${row.level.padEnd(4)} ` +
        `${String(row.words).padStart(5)}  ${(row.glossed * 100).toFixed(0).padStart(9)}%  ` +
        `${row.coverage === null ? "     —" : `${(row.coverage * 100).toFixed(1).padStart(5)}%`} ` +
        `${row.verdict.padEnd(11)} ${row.template ? "ok" : "INCOMPLETE"}`,
      );
    }

    console.log("");
    if (findings.length === 0) {
      console.log(`  ${rows.length} passage(s) inspected · no findings`);
    } else {
      console.log(`  ${findings.length} finding(s) across ${rows.length} passage(s):`);
      for (const f of findings) console.log(`    [${f.kind}] ${f.passage}: ${f.detail}`);
    }
  }

  await mongoose.disconnect();
  process.exitCode = findings.length === 0 ? 0 : 1;
}

runIfEntry(import.meta.url, main);
