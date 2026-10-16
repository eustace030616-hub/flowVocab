import { Schema, Document, models, model } from "mongoose";
import type { TargetLang } from "../lib/lang";

/**
 * A compound and its parts, validated at compile time rather than split at read time.
 *
 * The runtime split compounds by trying every cut and keeping one where both halves were known words.
 * With 280k lemmas that is a permissive test: it split the inflected adjective "kurzen" into
 * "kur" + "zen", and fused "kurzen Text" into the noun *Kurztext*. The same constraint applied once,
 * offline, and frozen into a table is a different proposition — the splits can be listed, reviewed
 * and tested.
 */
export interface ICompound extends Document {
  targetLang: TargetLang;
  /** The whole form, as a token join key. */
  form: string;
  /** Its parts, in order, each a vocabulary lemma. */
  parts: string[];
  source: string;
}

const CompoundSchema = new Schema<ICompound>(
  {
    targetLang: { type: String, enum: ["de", "en"], required: true },
    form: { type: String, required: true },
    parts: { type: [String], default: [] },
    source: { type: String, required: true },
  },
  { timestamps: true },
);

CompoundSchema.index({ targetLang: 1, form: 1 }, { unique: true });

export const Compound = models.Compound || model<ICompound>("Compound", CompoundSchema);
