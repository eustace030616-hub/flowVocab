/**
 * Generate the licence manifest and sync provenance.
 *
 *   npm run import:licences                from the catalogue only
 *   npm run import:licences -- --fetch-text  also try to embed verbatim licence texts
 *
 * Writes LICENSES/MANIFEST.md, LICENSES/provenance.json and one LICENSES/<dataset>.txt per
 * dataset, and upserts the same information into the Provenance collection.
 *
 * Everything is derived from src/lib/licence/datasets.ts, so the notices a build ships are
 * generated from the same source of truth that the importers check against — they cannot drift
 * apart without this failing first.
 */

import { Provenance } from "../../models/Provenance";
import { provenanceDocs, writeLicenceManifest } from "../../lib/licence";
import { connectDB } from "../../lib/db";
import { runIfEntry } from "../run";

async function main() {
  const fetchText = process.argv.includes("--fetch-text");

  const result = await writeLicenceManifest({ fetchText });

  console.log("Licence manifest");
  console.log("────────────────");
  console.log(`  directory        ${result.dir}`);
  console.log(`  datasets         ${result.datasets}`);
  console.log(`    shippable      ${result.shippable}`);
  console.log(`    share-alike / copyleft ${result.restricted}`);
  console.log(`    offline-only   ${result.offlineOnly}`);
  console.log(`  files written    ${result.written.length}`);
  if (!fetchText) {
    console.log("  (pass --fetch-text to embed verbatim licence texts)");
  }

  await connectDB()
    .then(async () => {
      const docs = provenanceDocs();
      await Provenance.deleteMany({});
      await Provenance.insertMany(docs);
      console.log(`  provenance docs  ${docs.length} synced`);
    })
    .catch((err: unknown) => {
      // The manifest is the part that must exist in a build; the collection is a convenience.
      console.log(
        `  provenance docs  NOT synced (${err instanceof Error ? err.message.split("\n")[0] : "db unavailable"})`,
      );
      console.log("                   run again with a database up, or: docker compose up -d db");
    });

  console.log(
    "\nReminder: offline-only datasets are recorded here with offlineOnly=true, but their data",
  );
  console.log("must never appear in the database, the repository, or the image.");
}

runIfEntry(import.meta.url, main);
