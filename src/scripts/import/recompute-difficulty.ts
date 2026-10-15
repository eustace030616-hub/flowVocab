/**
 * Fit the frequency → difficulty curve per language and write `Word.difficulty`.
 *
 *   npm run recompute:difficulty
 *   npm run recompute:difficulty -- --with-goethe-anchors   (offline calibration only)
 *
 * Evidence is attached by the import steps; this step is the only thing that decides difficulty,
 * so the curve can be re-fitted without re-importing anything.
 *
 * ## Where the labels come from, and why it matters
 *
 * English is calibrated on real CEFR lists (CEFR-J A1–B2, Octanove C1–C2).
 *
 * German has no such thing — no C1/C2 wordlist was ever published, and the A1–B1 Goethe lists may
 * not be redistributed — so by default German is calibrated on the ph98 levels, which are
 * *LLM-assigned*. German difficulty therefore inherits that weakness.
 *
 * `--with-goethe-anchors` instead calibrates German on the authoritative Goethe A1/A2/B1 lists,
 * downloaded to `data/offline-anchors/` for local use. Those wordlists are never stored anywhere:
 * they are read here, matched to frequencies already in the database, and reduced to a handful of
 * medians. That reduction is the whole point of Layer 0 — the curve is a derived fact, not the
 * protected list.
 *
 * ## What it writes
 *
 *   difficulty        always, when any frequency evidence exists
 *   level             only where no list supplied one, from the same curve, marked estimated
 *
 * A word with no frequency evidence keeps `difficulty = -1`. "Unknown" is a legitimate value and
 * must never be silently rendered as "easy" or "hard".
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Paragraph } from "../../models/Paragraph";
import { CEFR_LEVELS, isCefrLevel, type CefrLevel, type TargetLang } from "../../lib/lang";
import {
  describeCalibration,
  difficultyFromZipf,
  fitZipfCalibration,
  levelFromDifficulty,
  levelMidpoint,
  type Calibration,
  type Observation,
} from "../../lib/difficulty";
import { parseCsv } from "./profiles";
import { tokenizeWithLexicon } from "../../lib/learner/lexicon";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { wordSpans } from "../../lib/tokenize";
import { runIfEntry } from "../run";

const ANCHOR_DIR = path.join(process.cwd(), "data", "offline-anchors");

/**
 * Build observations from the Goethe A1/A2/B1 lists, for offline calibration only.
 *
 * The lists supply labels; the frequencies come from the database. Nothing from the lists is
 * persisted — only the medians computed from the resulting pairs.
 */
async function goetheObservations(): Promise<{ observations: Observation[]; levels: CefrLevel[] }> {
  const wanted: Array<{ lemmaKey: string; level: CefrLevel }> = [];

  for (const [level, file] of [
    ["A1", "goethe-A1.csv"],
    ["A2", "goethe-A2.csv"],
    ["B1", "goethe-B1.csv"],
  ] as Array<[CefrLevel, string]>) {
    const full = path.join(ANCHOR_DIR, file);
    if (!existsSync(full)) continue;
    const rows = parseCsv(readFileSync(full, "utf8"));
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const iLemma = header.indexOf("lemma");
    if (iLemma < 0) continue;
    for (const cells of rows.slice(1)) {
      const lemma = (cells[iLemma] ?? "").trim();
      if (lemma) wanted.push({ lemmaKey: lemmaKeyOf(lemma), level });
    }
  }

  if (wanted.length === 0) return { observations: [], levels: [] };

  const rows = await Word.find({
    targetLang: "de",
    lemmaKey: { $in: wanted.map((w) => w.lemmaKey) },
    "frequency.wordfreq": { $gt: 0 },
  })
    .select("lemmaKey frequency.wordfreq")
    .lean();

  const zipfByLemma = new Map(rows.map((r) => [r.lemmaKey, r.frequency?.wordfreq ?? 0]));

  const observations = wanted
    .map((w) => ({ zipf: zipfByLemma.get(w.lemmaKey) ?? 0, level: w.level }))
    .filter((o) => o.zipf > 0);

  return {
    observations,
    levels: [...new Set(observations.map((o) => o.level))].sort(
      (a, b) => CEFR_LEVELS.indexOf(a) - CEFR_LEVELS.indexOf(b),
    ),
  };
}

/** Observations from the labels already stored on the vocabulary. */
async function labelledObservations(lang: TargetLang): Promise<Observation[]> {
  const rows = await Word.find({
    targetLang: lang,
    level: { $ne: null },
    // Only real list labels calibrate the curve. A level this step estimated on a previous run
    // must never feed back in, or the curve would slowly fit its own output.
    levelEstimated: { $ne: true },
    "frequency.wordfreq": { $gt: 0 },
  })
    .select("level frequency.wordfreq")
    .lean();

  return rows
    .filter((r) => isCefrLevel(r.level) && (r.frequency?.wordfreq ?? 0) > 0)
    .map((r) => ({ zipf: r.frequency!.wordfreq!, level: r.level as CefrLevel }));
}

interface ApplyStats {
  scored: number;
  fromZipf: number;
  fromDwds: number;
  fromLevel: number;
  unknown: number;
  /** Rare enough to fall outside the fitted curve: difficulty is known, no label is claimed. */
  beyondCalibration: number;
  estimatedLevels: string[];
}

async function applyCalibration(lang: TargetLang, calibration: Calibration): Promise<ApplyStats> {
  const stats: ApplyStats = {
    scored: 0,
    fromZipf: 0,
    fromDwds: 0,
    fromLevel: 0,
    unknown: 0,
    beyondCalibration: 0,
    estimatedLevels: [],
  };

  const cursor = Word.find({ targetLang: lang })
    .select("level levelEstimated levelSource frequency")
    .lean()
    .cursor();

  let ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];

  for await (const doc of cursor) {
    const frequency = (doc.frequency ?? {}) as {
      wordfreq?: number;
      dwds?: number;
      leipzig?: number;
    };
    const zipf = frequency.wordfreq ?? 0;

    // A label is authoritative only when it came from a dataset. A level this step wrote on an
    // earlier run must be recomputed, not treated as evidence — otherwise the first run's output
    // becomes the second run's input and the step stops being re-runnable.
    const hasDatasetLabel = doc.level != null && doc.levelEstimated !== true;

    let difficulty = -1;
    let source = "";
    if (zipf > 0) {
      difficulty = difficultyFromZipf(zipf, calibration);
      source = "wordfreq+cefr";
      stats.fromZipf += 1;
    } else if (frequency.dwds !== undefined) {
      // No Zipf score: the DWDS class is coarse but is real evidence. Higher class means more
      // frequent, so this inverts — see difficultyForRow for the evidence.
      difficulty = 1 - frequency.dwds / 6;
      source = "dwds-class";
      stats.fromDwds += 1;
    } else if (hasDatasetLabel) {
      difficulty = levelMidpoint(doc.level as CefrLevel);
      source = "cefr-midpoint";
      stats.fromLevel += 1;
    } else {
      stats.unknown += 1;
    }

    const update: Record<string, unknown> = { difficulty, difficultySource: source || null };

    // An unlabelled word gets an estimated band from the curve — but ONLY when its frequency
    // falls inside the calibrated range.
    //
    // The curve clamps outside its anchors, which is right for *difficulty* (a word rarer than the
    // rarest anchor is not "more than C2") and wrong for a *label*: the German curve is fitted on
    // Goethe A1-B1, so 151,927 words rarer than the B1 anchor were being called "B1" purely
    // because the clamp stops there. That is an overclaim, and the honest answer is no label.
    //
    // The same reasoning rejects deriving a label from the DWDS-class fallback: seven coarse
    // buckets cannot support a six-band CEFR claim, and class 0 is an undifferentiated rare tail,
    // so 91,964 words were being called "C2" for having no information at all.
    // Asymmetric on purpose. anchors are ascending in zipf, so [0] is the RAREST anchor.
    //
    //   more frequent than the easiest anchor  → clamping is safe: the easiest band is a floor,
    //                                            so the most common words are still A1
    //   rarer than the rarest anchor           → clamping OVERCLAIMS: the hardest anchor is not a
    //                                            ceiling, so no label is asserted
    const beyondRarestAnchor =
      !(zipf > 0) || calibration.anchors.length < 2 || zipf < calibration.anchors[0].zipf;

    if (!hasDatasetLabel && difficulty >= 0 && !beyondRarestAnchor) {
      const estimated = levelFromDifficulty(difficulty);
      if (estimated) {
        update.level = estimated;
        update.levelEstimated = true;
        update.levelSource = "zipf-calibrated";
        stats.estimatedLevels.push(estimated);
      }
    } else if (!hasDatasetLabel && difficulty >= 0) {
      update.level = null;
      update.levelEstimated = false;
      update.levelSource = null;
      stats.beyondCalibration += 1;
    }

    stats.scored += 1;
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: update } } });
    if (ops.length >= 2000) {
      await Word.bulkWrite(ops, { ordered: false });
      ops = [];
      process.stdout.write(`\r  ${lang}: ${stats.scored.toLocaleString()} scored`);
    }
  }
  if (ops.length) await Word.bulkWrite(ops, { ordered: false });
  process.stdout.write("\n");
  return stats;
}

/**
 * Paragraph difficulty = the mean difficulty of its content words.
 *
 * This puts text difficulty and item difficulty on the same scale, which i+1 needs: you cannot
 * ask "is this text one step above this learner" if the two are measured differently.
 */
async function recomputeParagraphDifficulty(lang: TargetLang): Promise<number> {
  const paragraphs = await Paragraph.find({ targetLang: lang }).select("content").lean();
  let updated = 0;

  for (const paragraph of paragraphs) {
    const spans = await tokenizeWithLexicon(paragraph.content, lang);
    const keys = [...new Set(wordSpans(spans).map((s) => s.lemmaKey))];
    if (keys.length === 0) continue;

    const words = await Word.find({ targetLang: lang, lemmaKey: { $in: keys } })
      .select("difficulty")
      .lean();
    const known = words.map((w) => w.difficulty).filter((d) => d >= 0);
    if (known.length === 0) continue;

    const mean = known.reduce((sum, d) => sum + d, 0) / known.length;
    await Paragraph.updateOne(
      { _id: paragraph._id },
      { $set: { difficulty: mean, difficultySource: "mean-item-difficulty" } },
    );
    updated += 1;
  }
  return updated;
}

async function main() {
  const withGoethe = process.argv.includes("--with-goethe-anchors");
  await connectDB();

  console.log("Difficulty calibration");
  console.log("──────────────────────");

  let germanAnchors: Observation[] | null = null;
  if (withGoethe) {
    const { observations, levels } = await goetheObservations();
    if (observations.length) {
      germanAnchors = observations;
      console.log(
        `  Goethe anchors: ${observations.length} labelled words matched to frequencies ` +
          `(levels ${levels.join(", ")}) from ${path.relative(process.cwd(), ANCHOR_DIR)}`,
      );
      console.log("  offline calibration only — no wordlist is stored, only the fitted medians");
    } else {
      console.log("  --with-goethe-anchors given but no usable anchor data found; falling back");
    }
  }

  for (const lang of ["en", "de"] as const) {
    const anchors = lang === "de" ? germanAnchors : null;
    const observations = anchors ?? (await labelledObservations(lang));
    const calibration = fitZipfCalibration(observations);

    const basis = anchors ? "Goethe A1–B1 (offline)" : `${calibration.samples} labelled rows`;
    console.log(`\n  ${lang}: fitted on ${basis}`);
    console.log(`    ${describeCalibration(calibration)}`);

    const stats = await applyCalibration(lang, calibration);
    console.log(
      `    difficulty: ${stats.fromZipf.toLocaleString()} from Zipf · ` +
        `${stats.fromDwds.toLocaleString()} from DWDS class · ` +
        `${stats.fromLevel.toLocaleString()} from a label · ${stats.unknown.toLocaleString()} unknown`,
    );
    if (stats.estimatedLevels.length) {
      const histogram: Record<string, number> = {};
      for (const level of stats.estimatedLevels) histogram[level] = (histogram[level] ?? 0) + 1;
      console.log(
        `    estimated levels added for unlabelled words: ` +
          CEFR_LEVELS.filter((l) => histogram[l])
            .map((l) => `${l}:${histogram[l]}`)
            .join(" "),
      );
    }

    if (stats.beyondCalibration) {
      console.log(
        `    ${stats.beyondCalibration.toLocaleString()} words rarer than the curve's last anchor: ` +
          `difficulty set, level deliberately left unclaimed`,
      );
    }

    const paragraphs = await recomputeParagraphDifficulty(lang);
    console.log(`    paragraph difficulty recomputed: ${paragraphs}`);

    const out = path.join(process.cwd(), "data", `calibration-${lang}.json`);
    writeFileSync(out, JSON.stringify(calibration, null, 2), "utf8");
    console.log(`    curve → ${path.relative(process.cwd(), out)}`);
  }

  console.log("\nA word with no frequency evidence keeps difficulty = -1 (unknown).");
  console.log("German labels remain estimates: no German C1/C2 wordlist exists.");
}

runIfEntry(import.meta.url, main);
