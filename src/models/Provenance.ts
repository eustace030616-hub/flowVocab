import mongoose, { Schema, Document, models, model } from "mongoose";

/**
 * Licence provenance, one document per external dataset.
 *
 * This exists because almost every usable dictionary and frequency source is share-alike
 * (CC BY-SA) or copyleft (GPL). Merging such text into a collection alongside proprietary
 * text makes the whole collection an adaptation that must itself be licensed CC BY-SA —
 * so the licence has to be tracked per dataset, and the *unmodified* source files have to
 * stay in the image alongside their verbatim licence texts.
 *
 * The importers write this; the app reads it to render a Data Sources screen, so attribution
 * is generated from data rather than maintained by hand.
 */
export interface IProvenance extends Document {
  /** Stable id used in `Gloss.source`, e.g. "cc-cedict". */
  dataset: string;
  title: string;
  url: string;
  /** SPDX id where one exists, otherwise the dataset's own wording. */
  license: string;
  licenseUrl?: string;
  /** The exact attribution string the licence requires. */
  attribution: string;
  commercialUse: boolean;
  shareAlike: boolean;
  copyleft: boolean;
  /** True when the data may be used only for offline calibration and must never ship. */
  offlineOnly: boolean;

  retrievedAt: Date;
  sha256?: string;
  rowCount?: number;
  /** Which fields this dataset populated, e.g. ["Word.glosses", "Word.frequency.dwds"]. */
  contributesTo: string[];
  notes?: string;
}

const ProvenanceSchema = new Schema<IProvenance>(
  {
    dataset: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    url: { type: String, required: true },
    license: { type: String, required: true },
    licenseUrl: { type: String },
    attribution: { type: String, required: true },
    commercialUse: { type: Boolean, required: true },
    shareAlike: { type: Boolean, default: false },
    copyleft: { type: Boolean, default: false },
    offlineOnly: { type: Boolean, default: false },

    retrievedAt: { type: Date, default: Date.now },
    sha256: { type: String },
    rowCount: { type: Number },
    contributesTo: { type: [String], default: [] },
    notes: { type: String },
  },
  { timestamps: true },
);

export const Provenance =
  models.Provenance || model<IProvenance>("Provenance", ProvenanceSchema);
