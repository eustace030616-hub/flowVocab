/**
 * Seed both tracks.
 *
 *   npm run seed
 *
 * Content lives in seed-data.ts so the tests can tokenize the exact same text.
 *
 * The German paragraphs deliberately contain a compound ("Wortschatzaufbau"), a separable verb
 * ("steht … auf" → aufstehen), an inseparable one that must NOT be split ("versteht"), and a
 * false friend ("Gift" = poison, not a present) — because those are the cases the old
 * space-split, array-index model could not represent, and a seed that does not exercise them
 * would let a regression hide.
 */

import { connectDB } from "../lib/db";
import { Paragraph } from "../models/Paragraph";
import { Word } from "../models/Word";
import { Mark } from "../models/Mark";
import { Event } from "../models/Event";
import { User } from "../models/User";
import { Provenance } from "../models/Provenance";
import { lemmaKeyOf } from "../lib/tokenize/normalize";
import { tokenize, wordSpans } from "../lib/tokenize";
import {
  difficultyFromSeedLevel,
  SEED_PARAGRAPHS,
  SEED_WORDS,
} from "./seed-data";
import { runIfEntry } from "./run";

async function seed() {
  await connectDB();

  await Promise.all([
    Word.deleteMany({}),
    Paragraph.deleteMany({}),
    Mark.deleteMany({}),
    Event.deleteMany({}),
    User.deleteMany({}),
    Provenance.deleteMany({}),
  ]);

  // ── Vocabulary ────────────────────────────────────────────────────────────
  for (const word of SEED_WORDS) {
    await Word.create({
      targetLang: word.targetLang,
      lemmaKey: lemmaKeyOf(word.lemma),
      lemma: word.lemma,
      pos: word.pos,
      surfaceForms: [],
      glosses: word.glosses,
      level: word.level,
      // Hand-assigned for the demo, so it is flagged as an estimate rather than implied to come
      // from a CEFR list.
      levelEstimated: true,
      levelSource: "seed-manual",
      difficulty: difficultyFromSeedLevel(word.level),
      frequency: {},
      article: word.article,
      plural: word.plural,
      cognateWithEn: word.cognateWithEn,
      falseFriend: word.falseFriend,
      status: "unfamiliar",
      timesMet: 0,
      unfamiliarity: 0,
      lookupCount: 0,
      exposureCount: 0,
    });
  }

  // ── Paragraphs ────────────────────────────────────────────────────────────
  for (const paragraph of SEED_PARAGRAPHS) {
    // wordCount comes from the tokenizer, not from a hand-maintained number.
    const wordCount = wordSpans(tokenize(paragraph.content, paragraph.targetLang)).length;
    await Paragraph.create({
      targetLang: paragraph.targetLang,
      title: paragraph.title,
      content: paragraph.content,
      topic: paragraph.topic,
      wordCount,
      level: paragraph.level,
      difficulty: difficultyFromSeedLevel(paragraph.level),
      difficultySource: "seed-manual",
      coverage: -1,
      tokenizerVersion: 1,
      source: "seed",
    });
  }

  const counts = {
    paragraphs: {
      en: await Paragraph.countDocuments({ targetLang: "en" }),
      de: await Paragraph.countDocuments({ targetLang: "de" }),
    },
    words: {
      en: await Word.countDocuments({ targetLang: "en" }),
      de: await Word.countDocuments({ targetLang: "de" }),
    },
  };

  console.log("Seed complete");
  console.log("─────────────");
  console.log(`  paragraphs   en ${counts.paragraphs.en} · de ${counts.paragraphs.de}`);
  console.log(`  words        en ${counts.words.en} · de ${counts.words.de}`);
  console.log("  events       0 (the log starts empty; marks derive from it)");
  console.log();
  console.log("  German seed deliberately contains:");
  console.log("    compound          Wortschatzaufbau  → wortschatz + aufbau");
  console.log("    separable verb    steht … auf       → aufstehen");
  console.log("    inseparable       versteht          → verstehen (never split)");
  console.log("    false friend      Gift              → poison, not a present");
}

runIfEntry(import.meta.url, seed);
