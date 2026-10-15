import { Schema, Document, models, model, type Types } from "mongoose";
import type { GlossLang, TargetLang } from "../lib/lang";

/**
 * One translation, from one source, under one licence.
 *
 * Glosses live here rather than inside `Word` for a licensing reason, not a modelling preference.
 * Almost every usable dictionary is share-alike (CC BY-SA) or copyleft (GPL-3+), and the rule for
 * such data is that it stays separable: merging licensed gloss text into a collection that also
 * holds proprietary content makes the whole collection an adaptation that must carry the same
 * licence. A separate collection per source keeps the seams visible and lets a single source be
 * purged or re-imported without touching anything else.
 *
 * It also happens to be the better model: one headword legitimately has several glosses, in
 * several languages, from several sources, and they should be able to disagree in public.
 *
 * Read path: `(targetLang, lemmaKey, lang)` ordered by `rank`. Audit path: everything for one
 * `source`, which is what a licence review or a purge needs.
 */
export interface IGloss extends Document {
  /** Language of the headword being glossed. */
  targetLang: TargetLang;
  /** Join key of that headword. */
  lemmaKey: string;
  /** Optional link to the shared vocabulary entry. */
  wordId?: Types.ObjectId;

  /** Language of the gloss text itself. */
  lang: GlossLang;
  text: string;
  /** Disambiguator when a source distinguishes senses. */
  sense?: string;

  /** Dataset id from src/lib/licence/datasets.ts, e.g. "ding-beolingus-de-en". */
  source: string;
  /** Licence string as published by that dataset. */
  license: string;
  /** True when machine-generated rather than curated. */
  generated: boolean;

  /** Preference within a source; lower is better. */
  rank: number;
  /** Source-specific salience, e.g. the corpus frequency of the Chinese term. */
  weight?: number;
}

const GlossSchema = new Schema<IGloss>(
  {
    targetLang: { type: String, enum: ["en", "de"], required: true },
    lemmaKey: { type: String, required: true },
    wordId: { type: Schema.Types.ObjectId, ref: "Word" },

    lang: { type: String, enum: ["en", "zh"], required: true },
    text: { type: String, required: true },
    sense: { type: String },

    source: { type: String, required: true },
    license: { type: String, required: true },
    generated: { type: Boolean, default: false },

    rank: { type: Number, default: 0 },
    weight: { type: Number },
  },
  { timestamps: true },
);

// The read path.
GlossSchema.index({ targetLang: 1, lemmaKey: 1, lang: 1, rank: 1 });
// Re-importing a source must be idempotent, so the same gloss cannot land twice.
GlossSchema.index(
  { targetLang: 1, lemmaKey: 1, lang: 1, source: 1, text: 1 },
  { unique: true },
);
// The licence path: find everything one dataset contributed, to attribute it or remove it.
GlossSchema.index({ source: 1 });

export const Gloss = models.Gloss || model<IGloss>("Gloss", GlossSchema);
