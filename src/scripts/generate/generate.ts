/**
 * The generator: brief → text → measured → repaired if it fails → imported.
 *
 * This is the agent part. Its defining property is that the model does not get the last word — the
 * rubric does. A paragraph is generated, tokenized with the same tokenizer the reader uses, measured
 * against the same coverage thresholds the reader displays, and either imported or handed back with
 * its specific failures as feedback. An unattended generator with no acceptance test is a random
 * text generator with a nice prompt.
 *
 *   npm run generate:paragraphs                          # fulfil the briefs in briefs.ts
 *   npm run generate:paragraphs -- --level B1 --lang de  # one brief
 *   npm run generate:paragraphs -- --dry-run             # measure, write nothing
 *
 * Cost is reported per attempt, including reasoning tokens, because "low thinking" is a setting and
 * the number is the evidence about whether it is being honoured.
 */

import { connectDB } from "../../lib/db";
import { Paragraph } from "../../models/Paragraph";
import { Word } from "../../models/Word";
import { Gloss } from "../../models/Gloss";
import { TOKENIZER_VERSION } from "../../lib/tokenize";
import { assertShippable } from "../../lib/licence/datasets";
import { levelMidpoint } from "../../lib/difficulty";
import { glossLangFor, type CefrLevel, type TargetLang } from "../../lib/lang";
import { tokenizeWithLexicon } from "../../lib/learner/lexicon";
import { checkParagraph, measureParagraph, RUBRIC_LIMITS } from "../../lib/content/rubric";
import { BRIEFS, briefIdOf, type BriefSpec } from "./briefs";
import { deepseekProvider, describeProvider, type Provider } from "./provider";
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  buildSystemPrompt,
  buildTopicVocabularyPrompt,
  buildUserPrompt,
  parseGenerated,
  parseJudge,
  parseTopicVocabulary,
  type Brief,
  type VocabularyItem,
} from "./prompt";
import { runIfEntry } from "../run";

const SOURCE = "agent";
const MAX_ATTEMPTS = 4;

/**
 * How many replies may be unusable before giving up.
 *
 * Counted separately from measured attempts, and this is the reliability fix. An empty reply or
 * truncated JSON is an infrastructure failure, not a verdict on the text — but it was consuming one
 * of the four attempts, so a brief could burn its whole budget on two empty replies and one
 * malformed one and never be measured at all. That is exactly what happened to the German B2 brief:
 * four attempts, of which two produced no usable text.
 */
const MAX_UNUSABLE_REPLIES = 4;

/** Difficulty band for a level, matching the rubric's one-band window. */
function bandFor(level: CefrLevel): { low: number; high: number; centre: number } {
  const centre = levelMidpoint(level);
  const half = 1 / 12;
  return { low: centre - half, high: centre + half, centre };
}

/**
 * Sample the vocabulary the prompt is built from.
 *
 * Core words come from the bands *below* the level, weighted towards the top of that range: those
 * are the words a reader at this level knows well and which still carry meaning. Target words come
 * from the level's own band — the new material.
 */
async function sampleVocabulary(targetLang: TargetLang, level: CefrLevel, size: number) {
  const { low, high } = bandFor(level);
  const floor = Math.max(0, low - 0.45);

  const [coreRows, targetRows] = await Promise.all([
    Word.aggregate([
      { $match: { targetLang, origin: "import", difficulty: { $gte: floor, $lt: low - 0.02 } } },
      { $sample: { size } },
      { $project: { lemma: 1, lemmaKey: 1, difficulty: 1 } },
    ]),
    Word.aggregate([
      { $match: { targetLang, origin: "import", difficulty: { $gte: low, $lte: high } } },
      { $sample: { size: 8 } },
      { $project: { lemma: 1, lemmaKey: 1, difficulty: 1 } },
    ]),
  ]);

  const glossLang = glossLangFor(targetLang);
  const keys = [...coreRows, ...targetRows].map((r) => r.lemmaKey);
  const glosses = await Gloss.find({ targetLang, lang: glossLang, lemmaKey: { $in: keys } })
    .sort({ rank: 1 })
    .select("lemmaKey text")
    .lean();
  const glossOf = new Map<string, string>();
  for (const g of glosses) if (!glossOf.has(g.lemmaKey)) glossOf.set(g.lemmaKey, g.text);

  const toItem = (row: { lemma: string; lemmaKey: string }): VocabularyItem => ({
    word: row.lemma,
    gloss: glossOf.get(row.lemmaKey) ?? null,
  });

  return { core: coreRows.map(toItem), target: targetRows.map(toItem) };
}

/**
 * Ask the model what the topic needs, then keep only what the data agrees is simple enough.
 *
 * Every proposal is looked up: it must be in the vocabulary, at or below the level's band, and have
 * a gloss in the reader's language. A word the model thinks is simple but the data places at C1 is
 * dropped — which is the whole reason to ask the data rather than trust the answer.
 */
async function proposeTopicWords(
  provider: Provider,
  spec: BriefSpec,
  options: { onAttempt?: (line: string) => void } = {},
): Promise<VocabularyItem[]> {
  const { system, user } = buildTopicVocabularyPrompt(spec.targetLang, spec.level, spec.topic);
  const completion = await provider.complete({ system, user, maxTokens: 2000, json: true });
  const proposed = parseTopicVocabulary(completion.text);
  if (proposed.length === 0) return [];

  const { high } = bandFor(spec.level);
  const keys = proposed.map((word) => word.toLowerCase().replace(/^(der|die|das|the|a|an)\s+/, "").trim());
  const rows = await Word.find({
    targetLang: spec.targetLang,
    lemmaKey: { $in: keys },
    origin: "import",
    difficulty: { $gte: 0, $lte: high },
  })
    .select("lemma lemmaKey difficulty")
    .lean();

  const glossLang = glossLangFor(spec.targetLang);
  const glosses = await Gloss.find({
    targetLang: spec.targetLang,
    lang: glossLang,
    lemmaKey: { $in: rows.map((r) => r.lemmaKey) },
  })
    .sort({ rank: 1 })
    .select("lemmaKey text")
    .lean();
  const glossOf = new Map<string, string>();
  for (const g of glosses) if (!glossOf.has(g.lemmaKey)) glossOf.set(g.lemmaKey, g.text);

  const kept = rows
    .filter((row) => glossOf.has(row.lemmaKey))
    .map((row) => ({ word: row.lemma, gloss: glossOf.get(row.lemmaKey) ?? null }));

  options.onAttempt?.(
    `    topic words: ${proposed.length} proposed · ${rows.length} at or below ${spec.level} · ${kept.length} glossed`,
  );
  return kept;
}

export interface GenerationOutcome {
  spec: BriefSpec;
  attempts: number;
  providerCalls: number;
  reasoningTokens: number;
  passed: boolean;
  content: string | null;
  title: string | null;
  issues: string[];
  coverage: number;
  level: CefrLevel | null;
  prompt: string;
  dryRun: boolean;
}

/**
 * Generate, measure, and repair until the rubric passes or the attempts run out.
 *
 * Every attempt is measured with the reader's own tokenizer, so a text that would fail at read time
 * fails here instead — including the vocabulary the tokenizer cannot resolve, which is the failure
 * that otherwise only shows up as a word with no translation.
 */
export async function generateOne(
  provider: Provider,
  spec: BriefSpec,
  options: { dryRun?: boolean; onAttempt?: (line: string) => void } = {},
): Promise<GenerationOutcome> {
  let attempts = 0;
  let providerCalls = 0;
  let reasoningTokens = 0;

  const vocabulary = await sampleVocabulary(spec.targetLang, spec.level, spec.coreSize);

  const brief: Brief = {
    targetLang: spec.targetLang,
    level: spec.level,
    topic: spec.topic,
    words: spec.words,
    // Topic words come first: they are the ones the scene actually needs, and a random sample below
    // the level does not reliably contain them.
    core: vocabulary.core,
    target: vocabulary.target,
  };

  const topicWords = await proposeTopicWords(provider, spec, options);
  providerCalls += 1;
  if (topicWords.length) {
    const seen = new Set(brief.core.map((item) => item.word.toLowerCase()));
    const merged = [...topicWords.filter((item) => !seen.has(item.word.toLowerCase())), ...brief.core];
    brief.core = merged.slice(0, Math.max(spec.coreSize, 20));
  }

  const system = buildSystemPrompt(brief);
  let feedback: string[] | undefined;
  let lastIssues: string[] = [];
  let lastMetrics: { coverage: number; measuredLevel: CefrLevel | null } = { coverage: 0, measuredLevel: null };

  // The writing budget, which reasoning also draws on. Raised when a reply comes back empty, because
  // the cause is almost always that the model thought until the budget ran out and never wrote.
  let budget = 8000;

  let unusableReplies = 0;
  while (attempts < MAX_ATTEMPTS && unusableReplies < MAX_UNUSABLE_REPLIES) {
    attempts += 1;
    const user = buildUserPrompt(brief, feedback);
    const completion = await provider.complete({ system, user, maxTokens: budget, json: true });
    providerCalls += 1;
    reasoningTokens += completion.reasoningTokens;

    if (!completion.text.trim()) {
      // Not a formatting problem, and rubric feedback cannot fix it: the model spent the whole budget
      // on reasoning. Retrying with the same limit would fail identically, so the limit changes.
      unusableReplies += 1;
      options.onAttempt?.(
        `    reply ${attempts}: empty — ${completion.reasoningTokens} reasoning tokens of ${budget}; ` +
          `raising the budget, attempt not counted`,
      );
      budget = Math.min(budget * 2, 32000);
      feedback = undefined;
      continue;
    }

    const parsed = parseGenerated(completion.text);
    if (!parsed) {
      unusableReplies += 1;
      feedback = ["The reply was not readable as JSON with a title and content."];
      options.onAttempt?.(
        `    reply ${attempts}: unreadable (${completion.text.length} chars, ${completion.reasoningTokens} reasoning tokens), attempt not counted`,
      );
      continue;
    }

    // Measured with the reader's tokenizer and the reader's thresholds — not a paraphrase of them.
    const spans = await tokenizeWithLexicon(parsed.content, spec.targetLang);
    const keys = [...new Set(spans.filter((s) => s.kind === "word").map((s) => s.lemmaKey))];
    const words = await Word.find({ targetLang: spec.targetLang, lemmaKey: { $in: keys }, origin: "import" })
      .select("lemmaKey difficulty")
      .lean();
    const difficultyOf = new Map<string, number>();
    for (const w of words) {
      const current = difficultyOf.get(w.lemmaKey);
      if (current === undefined || w.difficulty < current) difficultyOf.set(w.lemmaKey, w.difficulty);
    }

    const glossRows = await Gloss.find({
      targetLang: spec.targetLang,
      lang: glossLangFor(spec.targetLang),
      lemmaKey: { $in: keys },
    })
      .select("lemmaKey")
      .lean();
    const glossKeys = new Set(glossRows.map((g) => g.lemmaKey));

    const verdict = checkParagraph(
      spans.map((s) => ({ lemmaKey: s.lemmaKey, kind: s.kind })),
      {
        level: spec.level,
        difficultyOf: (key) => difficultyOf.get(key),
        hasGloss: (key) => glossKeys.has(key),
      },
    );

    lastIssues = verdict.issues;
    lastMetrics = { coverage: verdict.metrics.coverage, measuredLevel: verdict.metrics.measuredLevel };
    if (!verdict.passed) {
      options.onAttempt?.(
        `    attempt ${attempts}: rejected by the rubric · ${verdict.metrics.wordTokens} words · ` +
          `coverage ${(verdict.metrics.coverage * 100).toFixed(1)}% · ` +
          `median word ${verdict.metrics.medianDifficulty.toFixed(2)} · ${completion.reasoningTokens} reasoning · ` +
          verdict.issues.slice(0, 2).join("; "),
      );
    }

    if (verdict.passed) {
      // The objective rubric cannot see whether the sentences relate to each other. Every measurable
      // property was correct in the passage that produced "Sie tanzt am Abgrund. Anscheinend
      // studieren sie Physik." — so a reader is asked, and its complaints go back into the loop.
      const judgeCall = await provider.complete({
        system: buildJudgeSystemPrompt(spec.targetLang),
        user: buildJudgeUserPrompt(parsed.content),
        maxTokens: 3000,
        json: true,
      });
      providerCalls += 1;
      reasoningTokens += judgeCall.reasoningTokens;
      const judgement = parseJudge(judgeCall.text);

      options.onAttempt?.(
        `    attempt ${attempts}: measures up · judge ${judgement.coherent ? "accepts" : "rejects"}` +
          // The text itself, because a rejection is not diagnosable from a list of complaints.
          (judgement.coherent ? "" : ` · "${parsed.content.slice(0, 90)}…"`),
      );

      if (!judgement.coherent) {
        feedback = [
          "The passage was rejected as incoherent. Fix exactly this:",
          ...judgement.problems,
          "Rewrite it as one scene where each sentence follows from the previous one.",
        ];
        continue;
      }

      return {
        spec,
        attempts,
        providerCalls,
        reasoningTokens,
        passed: true,
        content: parsed.content,
        title: parsed.title,
        issues: [],
        coverage: verdict.metrics.coverage,
        level: verdict.metrics.measuredLevel,
        prompt: `${system}\n\n${user}`,
        dryRun: options.dryRun === true,
      };
    }

    // Generic complaints do not converge. "Only 66% of words have a gloss" leaves the model guessing
    // which words to replace, and it guessed wrong twice in a row on the English brief; naming them
    // turns the repair step into an instruction it can follow.
    const surfaceFor = new Map<string, string>();
    for (const span of spans) {
      if (span.kind === "word" && !surfaceFor.has(span.lemmaKey)) {
        surfaceFor.set(span.lemmaKey, span.surface);
      }
    }
    const unglossed = keys.filter((key) => !glossKeys.has(key)).map((key) => surfaceFor.get(key) ?? key);
    const unplaced = keys.filter((key) => difficultyOf.get(key) === undefined).map((key) => surfaceFor.get(key) ?? key);

    feedback = [...verdict.issues];

    // The words that actually caused a coverage failure, worst first. Naming the unglossed words
    // fixed that failure on the next attempt; naming these is the same fix for the other one. The
    // German A2 brief failed twice at 93.3% and 94.0% against a 94% floor without the model being
    // told *which* words were too hard for A2, which is not a thing it can guess.
    const { high } = bandFor(spec.level);
    const tooHard = keys
      .filter((key) => (difficultyOf.get(key) ?? -1) > high)
      .sort((a, b) => (difficultyOf.get(b) ?? 0) - (difficultyOf.get(a) ?? 0))
      .map((key) => surfaceFor.get(key) ?? key);
    if (tooHard.length) {
      feedback.push(
        `These words are above ${spec.level} and are what makes the passage too hard — replace each ` +
          `with a simpler everyday word: ${tooHard.slice(0, 15).join(", ")}`,
      );
    }

    if (unglossed.length) {
      feedback.push(
        `These words have no translation available and must be replaced with CORE words: ${unglossed.slice(0, 20).join(", ")}`,
      );
    }
    if (unplaced.length) {
      feedback.push(
        `These words are not in the vocabulary at all and must be replaced: ${unplaced.slice(0, 20).join(", ")}`,
      );
    }
  }

  return {
    spec,
    attempts,
    providerCalls,
    reasoningTokens,
    passed: false,
    content: null,
    title: null,
    issues: lastIssues,
    coverage: lastMetrics.coverage,
    level: lastMetrics.measuredLevel,
    prompt: "",
    dryRun: options.dryRun === true,
  };
}

/** Write a passing paragraph, replacing any earlier generated text with the same title. */
async function importParagraph(outcome: GenerationOutcome): Promise<string> {
  if (!outcome.content || !outcome.title) throw new Error("nothing to import");
  const spec = outcome.spec;

  // The prompt is kept for provenance, as the schema intends.
  const promptSnapshot = outcome.prompt.length > 4000 ? `${outcome.prompt.slice(0, 4000)}…` : outcome.prompt;

  // Identity is the brief. The title is model output and changes between runs; using it as the key
  // made every regeneration a new paragraph rather than a replacement.
  const result = await Paragraph.findOneAndUpdate(
    { targetLang: spec.targetLang, briefId: briefIdOf(spec) },
    {
      $set: {
        targetLang: spec.targetLang,
        briefId: briefIdOf(spec),
        title: outcome.title,
        content: outcome.content,
        topic: spec.topic,
        wordCount: outcome.content.split(/\s+/).filter(Boolean).length,
        level: spec.level,
        difficulty: levelMidpoint(spec.level),
        difficultySource: "generated-target",
        coverage: outcome.coverage,
        tokenizerVersion: TOKENIZER_VERSION,
        source: SOURCE,
        promptSnapshot,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return String(result?._id ?? "?");
}

/**
 * Re-measure every stored generated paragraph against the rubric, as the reader would serve it.
 *
 * The acceptance test runs at generation time; this is the same test run later, over what is actually
 * in the database, with the current lexicon and glossary. Without it there is no way to tell an
 * accepted paragraph from one that was accepted under a glossary that has since changed — which is
 * exactly what happened when the function-word and irregular-verb imports landed.
 */
async function verifyStored(): Promise<number> {
  const stored = await Paragraph.find({ source: SOURCE })
    .select("targetLang title content level")
    .lean();
  if (stored.length === 0) {
    console.log("  no stored generated paragraphs to verify");
    return 0;
  }

  let failed = 0;
  for (const paragraph of stored) {
    const level = (paragraph.level ?? "A2") as CefrLevel;
    const spans = await tokenizeWithLexicon(paragraph.content, paragraph.targetLang as TargetLang);
    const keys = [...new Set(spans.filter((s) => s.kind === "word").map((s) => s.lemmaKey))];

    const words = await Word.find({ targetLang: paragraph.targetLang, lemmaKey: { $in: keys }, origin: "import" })
      .select("lemmaKey difficulty")
      .lean();
    const difficultyOf = new Map<string, number>();
    for (const w of words) {
      const current = difficultyOf.get(w.lemmaKey);
      if (current === undefined || w.difficulty < current) difficultyOf.set(w.lemmaKey, w.difficulty);
    }
    const glossKeys = new Set(
      (
        await Gloss.find({
          targetLang: paragraph.targetLang,
          lang: glossLangFor(paragraph.targetLang as TargetLang),
          lemmaKey: { $in: keys },
        })
          .select("lemmaKey")
          .lean()
      ).map((g) => g.lemmaKey),
    );

    const verdict = checkParagraph(
      spans.map((s) => ({ lemmaKey: s.lemmaKey, kind: s.kind })),
      { level, difficultyOf: (key) => difficultyOf.get(key), hasGloss: (key) => glossKeys.has(key) },
    );
    const mark = verdict.passed ? "ok  " : "FAIL";
    if (!verdict.passed) failed += 1;
    console.log(
      `  ${mark} ${paragraph.targetLang} ${level} · ${paragraph.title} · ` +
        `${verdict.metrics.wordTokens} words · coverage ${(verdict.metrics.coverage * 100).toFixed(1)}% · ` +
        `glossed ${(verdict.metrics.glossed * 100).toFixed(0)}%` +
        (verdict.passed ? "" : ` · ${verdict.issues.join("; ")}`),
    );
  }
  return failed;
}

async function main() {
  // Provenance is an obligation in both directions: the vocabulary the prompt is built from comes
  // from licensed datasets, and the output is itself a data source with terms of its own.
  assertShippable("cefrj-vocabulary-profile-1.5");
  assertShippable("deepseek-generated");
  const provider = deepseekProvider();
  const dryRun = process.argv.includes("--dry-run");
  const argOf = (flag: string) =>
    process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
  const onlyLevel = argOf("--level");
  const onlyLang = argOf("--lang");

  console.log("generated paragraphs — model output accepted only if it measures up");
  console.log("─────────────────────────────────────────────────────────────────────");
  console.log(describeProvider(provider));
  console.log(`  mode         ${dryRun ? "dry run (nothing written)" : "import"}`);
  console.log("");

  await connectDB();

  if (process.argv.includes("--verify")) {
    const failed = await verifyStored();
    console.log(`\n  ${failed === 0 ? "all stored paragraphs still measure up" : `${failed} no longer measure up`}`);
    process.exitCode = failed === 0 ? 0 : 1;
    return;
  }

  const specs = BRIEFS.filter(
    (b) => (!onlyLevel || b.level === onlyLevel) && (!onlyLang || b.targetLang === onlyLang),
  );
  const outcomes: GenerationOutcome[] = [];

  for (const spec of specs) {
    console.log(`  ${spec.targetLang} ${spec.level} · ${spec.topic} (~${spec.words} words)`);
    const outcome = await generateOne(provider, spec, {
      dryRun,
      onAttempt: (line) => console.log(line),
    });
    outcomes.push(outcome);

    if (outcome.passed && !dryRun) {
      const id = await importParagraph(outcome);
      console.log(`    imported ${id}`);
    } else if (!outcome.passed) {
      console.log(`    rejected after ${outcome.attempts} attempts`);
      for (const issue of outcome.issues) console.log(`      · ${issue}`);
    }
    console.log("");
  }

  const passed = outcomes.filter((o) => o.passed);
  const calls = outcomes.reduce((n, o) => n + o.providerCalls, 0);
  const reasoning = outcomes.reduce((n, o) => n + o.reasoningTokens, 0);
  console.log(
    `  ${passed.length}/${outcomes.length} accepted · ${calls} model calls · ${reasoning} reasoning tokens`,
  );
  if (reasoning === 0 && calls > 0) {
    console.log("  note: no reasoning tokens reported, so the low thinking setting may not be in effect");
  }
}

runIfEntry(import.meta.url, main);
