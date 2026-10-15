import mongoose, { Schema, Document, models, model } from "mongoose";
import type { CefrLevel, GlossLang, TargetLang } from "../lib/lang";

export type WordStatus = "unfamiliar" | "learning" | "known";

/**
 * A translation, in a specific gloss language, from a specific source with a specific licence.
 *
 * Glosses are a list rather than a single `definition` string because the same item needs
 * different translations per track (an English headword glossed in Chinese for `zh-en`,
 * a German headword glossed in English for `en-de`), and because nearly every usable
 * dictionary source is share-alike or copyleft and therefore has to stay attributable.
 */
export interface Gloss {
  lang: GlossLang;
  text: string;
  sense?: string;
  /** Dataset id, e.g. "cc-cedict", "wikdict-en-de", "cefrj-vocabulary-profile-1.5". */
  source: string;
  /** Licence string as published by that dataset. */
  license: string;
  /** True when machine-generated (MT/LLM) rather than human-curated. */
  generated: boolean;
}

/** One column per independent corpus. Their agreement is a confidence signal. */
export interface Frequency {
  /** Zipf score from wordfreq (higher = more frequent). */
  wordfreq?: number;
  /** DWDS Häufigkeitsklasse 0–6 (lower = more frequent). */
  dwds?: number;
  /** Leipzig corpus rank. */
  leipzig?: number;
}

export interface IWord extends Document {
  targetLang: TargetLang;
  /**
   * Primary join key: NFC + casefold. Together with targetLang this is what keeps German
   * *Gift* and English *gift* apart — the thing the original schema could not do.
   */
  lemmaKey: string;
  /** Canonical display form. German nouns keep their capital. */
  lemma: string;
  /** Part of speech, "" when the source does not say. Part of the uniqueness key. */
  pos: string;
  /** Inflected forms, so running text can be matched back to this headword. */
  surfaceForms: string[];
  glosses: Gloss[];

  /** CEFR label. null is a legitimate value: German has no C1/C2 wordlist. */
  level: CefrLevel | null;
  /** True when the label is an estimate (frequency band, or LLM-assigned). */
  levelEstimated: boolean;
  levelSource: string | null;

  /** Continuous difficulty in [0,1]; -1 when unknown. */
  difficulty: number;
  frequency: Frequency;

  /** German only: definite article and plural. Without the article an entry is unusable. */
  article?: string;
  plural?: string;
  /** English↔German interference flags: they distort guessing and transfer. */
  cognateWithEn?: boolean;
  falseFriend?: boolean;

  // ── Derived learner state ──────────────────────────────────────────────────
  // A materialised cache folded from the append-only Event log. Never authoritative:
  // every field here can be recomputed from events. See src/lib/learner/state.ts.
  status: WordStatus;
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const GlossSchema = new Schema<Gloss>(
  {
    lang: { type: String, enum: ["en", "zh"], required: true },
    text: { type: String, required: true },
    sense: { type: String },
    source: { type: String, required: true },
    license: { type: String, required: true },
    generated: { type: Boolean, default: false },
  },
  { _id: false },
);

const WordSchema = new Schema<IWord>(
  {
    targetLang: { type: String, enum: ["en", "de"], required: true },
    lemmaKey: { type: String, required: true },
    lemma: { type: String, required: true },
    pos: { type: String, default: "" },
    surfaceForms: { type: [String], default: [] },
    glosses: { type: [GlossSchema], default: [] },

    level: { type: String, enum: ["A1", "A2", "B1", "B2", "C1", "C2", null], default: null },
    levelEstimated: { type: Boolean, default: false },
    levelSource: { type: String, default: null },

    difficulty: { type: Number, default: -1 },
    frequency: {
      wordfreq: { type: Number },
      dwds: { type: Number },
      leipzig: { type: Number },
    },

    article: { type: String },
    plural: { type: String },
    cognateWithEn: { type: Boolean },
    falseFriend: { type: Boolean },

    status: { type: String, enum: ["unfamiliar", "learning", "known"], default: "unfamiliar" },
    timesMet: { type: Number, default: 0 },
    unfamiliarity: { type: Number, default: 0 },
    lookupCount: { type: Number, default: 0 },
    exposureCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Identity is (language, lemma, part of speech). The old schema was unique on `word` alone,
// which merged German and English homographs into a single record.
WordSchema.index({ targetLang: 1, lemmaKey: 1, pos: 1 }, { unique: true });
WordSchema.index({ targetLang: 1, lemmaKey: 1 });
// Serving queries walk the difficulty ladder within one language.
WordSchema.index({ targetLang: 1, difficulty: 1 });

export const Word = models.Word || model<IWord>("Word", WordSchema);
