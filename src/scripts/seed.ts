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
import { Gloss } from "../models/Gloss";
import { lemmaKeyOf } from "../lib/tokenize/normalize";
import { tokenize, wordSpans } from "../lib/tokenize";
import {
  difficultyFromSeedLevel,
  SEED_PARAGRAPHS,
  SEED_SOURCE,
  SEED_WORDS,
} from "./seed-data";
import { runIfEntry } from "./run";

async function seed() {
  await connectDB();

  // `--reset` also drops learner history and imported vocabulary. Off by default, because the
  // documented order is `import:*` then `seed`, and a plain seed must not undo the imports.
  const reset = process.argv.includes("--reset");

  // Only the demo content is replaced. Imported vocabulary (levelSource from a dataset) and
  // learner history are left alone unless --reset is passed: wiping a learner's events to
  // re-seed demo paragraphs would be a data-loss bug, not a convenience.
  const oldParagraphIds = (await Paragraph.find({ source: "seed" }).select("_id").lean()).map(
    (p) => p._id,
  );

  await Paragraph.deleteMany({ source: "seed" });
  await Mark.deleteMany({ paragraphId: { $in: oldParagraphIds } });
  await Event.deleteMany({ paragraphId: { $in: oldParagraphIds } });

  // Demo vocabulary overlaps the imported datasets — "thicket" is in CEFR-J, "aufstehen" is in
  // DWDS — so seeding must not insert blindly. Two steps keep the two sources separable:
  //
  //   1. words that exist *only* because of the seed are removed
  //   2. demo glosses are removed by source and re-added
  //
  // A word that also arrived from an import keeps its level, frequency and difficulty: the
  // dataset is better evidence than a hand-written seed value.
  await Word.deleteMany({ levelSource: "seed-manual" });
  await Gloss.deleteMany({ source: SEED_SOURCE });

  if (reset) {
    await Promise.all([
      Word.deleteMany({}),
      Paragraph.deleteMany({}),
      Mark.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
      Provenance.deleteMany({}),
    ]);
    console.log("  --reset: vocabulary, learner history and users cleared");
  }

  // ── Vocabulary ────────────────────────────────────────────────────────────
  for (const word of SEED_WORDS) {
    await Word.updateOne(
      { targetLang: word.targetLang, lemmaKey: lemmaKeyOf(word.lemma), pos: word.pos },
      {
        $setOnInsert: {
          targetLang: word.targetLang,
          lemmaKey: lemmaKeyOf(word.lemma),
          lemma: word.lemma,
          pos: word.pos,
          surfaceForms: [],
          frequency: {},
          level: word.level,
          // Hand-assigned for the demo, so it is flagged as an estimate rather than implied to
          // come from a CEFR list.
          levelEstimated: true,
          levelSource: "seed-manual",
          difficulty: difficultyFromSeedLevel(word.level),
          article: word.article,
          plural: word.plural,
          cognateWithEn: word.cognateWithEn,
          falseFriend: word.falseFriend,
        },
      },
      { upsert: true },
    );
  }

  // ── Glosses ───────────────────────────────────────────────────────────────
  // Translations live in their own collection, one document per gloss per source, so that
  // share-alike and copyleft dictionary text never mixes into the shared vocabulary entries.
  for (const word of SEED_WORDS) {
    const entry = await Word.findOne({
      targetLang: word.targetLang,
      lemmaKey: lemmaKeyOf(word.lemma),
      pos: word.pos,
    })
      .select("_id")
      .lean();

    for (const [index, g] of word.glosses.entries()) {
      await Gloss.updateOne(
        {
          targetLang: word.targetLang,
          lemmaKey: lemmaKeyOf(word.lemma),
          lang: g.lang,
          source: g.source,
          text: g.text,
        },
        {
          $set: {
            wordId: entry?._id,
            license: g.license,
            generated: g.generated,
            rank: index,
          },
        },
        { upsert: true },
      );
    }
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
