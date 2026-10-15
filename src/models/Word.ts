import mongoose, { Schema, Document, models, model } from "mongoose";
import type { CefrLevel, TargetLang } from "../lib/lang";

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
  // NOTE: translations are NOT stored here. See models/Gloss.ts — share-alike and copyleft
  // dictionary text has to stay in its own collection, and one headword legitimately has
  // several glosses from several sources.

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

  // NOTE: learner state (status, timesMet, unfamiliarity, …) is NOT stored here.
  // A Word is shared reference data; how well a given learner knows it lives in WordState,
  // keyed by (userId, targetLang, lemmaKey). Keeping it here would make two learners
  // overwrite each other's history.

  createdAt: Date;
  updatedAt: Date;
}

const WordSchema = new Schema<IWord>(
  {
    targetLang: { type: String, enum: ["en", "de"], required: true },
    lemmaKey: { type: String, required: true },
    lemma: { type: String, required: true },
    pos: { type: String, default: "" },
    surfaceForms: { type: [String], default: [] },

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
