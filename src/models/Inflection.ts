import { Schema, Document, models, model } from "mongoose";
import type { TargetLang } from "../lib/lang";

/**
 * A surface form mapped to its citation form: `liest` → `lesen`, `kurzen` → `kurz`.
 *
 * This exists because suffix rules cannot get German inflection right, and getting it wrong is
 * visible to the learner. "liest" is not a verb form of anything the rules can reach — the stem
 * changes (lesen → liest) — so the surface was matching an unrelated noun entry, *Liest*, and the
 * preview showed a noun's headword with a verb form's description. "kurzen" fared no better: the
 * rules produced "kurze", which is a noun entry (*Kurze*), while the word is an inflection of the
 * adjective *kurz*.
 *
 * The mapping is stated by Wiktionary (`form_of`), not inferred, and covers 72% of its German
 * entries. Licence: CC BY-SA 4.0, share-alike, hence its own collection.
 */
export interface IInflection extends Document {
  targetLang: TargetLang;
  /** Join key of the inflected surface form. */
  form: string;
  /** The citation form, as written in the source (so nouns keep their capital). */
  base: string;
  /** Join key of the base. */
  baseLemmaKey: string;
  pos: string;
  source: string;
  license: string;
}

const InflectionSchema = new Schema<IInflection>(
  {
    targetLang: { type: String, enum: ["en", "de"], required: true },
    form: { type: String, required: true },
    base: { type: String, required: true },
    baseLemmaKey: { type: String, required: true },
    pos: { type: String, default: "" },
    source: { type: String, required: true },
    license: { type: String, required: true },
  },
  { timestamps: true },
);

// The read path: the tokenizer asks for a batch of forms while lexing a paragraph.
InflectionSchema.index({ targetLang: 1, form: 1 });
// Re-importing a source must be idempotent.
InflectionSchema.index(
  { targetLang: 1, form: 1, baseLemmaKey: 1, pos: 1, source: 1 },
  { unique: true },
);
InflectionSchema.index({ source: 1 });

export const Inflection = models.Inflection || model<IInflection>("Inflection", InflectionSchema);
