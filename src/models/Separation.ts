import { Schema, Document, models, model } from "mongoose";
import type { TargetLang } from "../lib/lang";

/**
 * A separable verb's prefix, stated rather than guessed.
 *
 * `auf` belongs to `stehen` in "er steht früh **auf**". Whether a word is a particle is a syntactic
 * fact; the runtime used to infer it from proximity and a word list, and produced *einwachsen* from
 * "wächst eine", *Kurztext* from "kurzen Text", and *gegenübersetzen* from "setzte … gegenüber".
 *
 * Wiktionary states it directly — a separable verb is written `auf.stehen` — so the pairs come from
 * there and the runtime looks them up instead of guessing.
 */
export interface ISeparation extends Document {
  targetLang: TargetLang;
  /** The separated prefix, e.g. "auf". */
  particle: string;
  /** The verb's dictionary form, e.g. "stehen". */
  verb: string;
  /** The merged infinitive, e.g. "aufstehen" — what the span resolves to. */
  merged: string;
  source: string;
}

const SeparationSchema = new Schema<ISeparation>(
  {
    targetLang: { type: String, enum: ["de", "en"], required: true },
    particle: { type: String, required: true },
    verb: { type: String, required: true },
    merged: { type: String, required: true },
    source: { type: String, required: true },
  },
  { timestamps: true },
);

// The read path: the tokenizer asks for a batch of particles while lexing a paragraph.
SeparationSchema.index({ targetLang: 1, particle: 1 });
SeparationSchema.index({ targetLang: 1, particle: 1, verb: 1 }, { unique: true });

export const Separation = models.Separation || model<ISeparation>("Separation", SeparationSchema);
