/**
 * Repack every stored passage with the current pipeline, and optionally push the result to D1.
 *
 * A package is a snapshot of the analysis at the moment the passage was written. Upgrading the tokeniser,
 * the lemmatiser or the gloss source does not change a package that already exists, so the reader keeps
 * seeing the old analysis until the passage is repacked. This is the migration that makes "every paragraph
 * uses the new stack" true rather than intended.
 *
 *   FLOWWING_TOKENIZER=somajo npm run repack:all
 *   FLOWWING_TOKENIZER=somajo npm run repack:all -- --push     (also send each package to D1)
 */
import { all, openDatabase } from "../../lib/store/db";
import { packParagraph, packageFor, PACKAGE_VERSION } from "../../lib/content/pack";
import { callService, serviceConfig } from "../worker/client";

async function pushToD1(targets: Array<Record<string, unknown>>): Promise<void> {
  const config = serviceConfig();
  let pushed = 0;
  for (const paragraph of targets) {
    const pack = packageFor(String(paragraph.id));
    if (!pack) continue;
    // The Worker stores the row and the package; sending the paragraph keeps the two in step.
    try {
      await callService(config, "/passages", {
        method: "POST",
        body: JSON.stringify({ paragraph: { ...paragraph, buffered: 1 }, package: pack }),
      });
      pushed += 1;
    } catch (error) {
      console.warn(`  push failed for ${String(paragraph.id)}: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`  pushed ${pushed} packages to D1`);
}

async function main(): Promise<void> {
  openDatabase();
  const paragraphs = all<{ id: string; targetLang: string }>(
    "SELECT id, targetLang FROM paragraphs ORDER BY createdAt",
  );
  const started = Date.now();
  let repacked = 0;
  let failed = 0;

  for (const paragraph of paragraphs) {
    try {
      await packParagraph(paragraph.id);
      repacked += 1;
    } catch (error) {
      failed += 1;
      console.warn(`  ${paragraph.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  repacked ${repacked}/${paragraphs.length} in ${seconds}s (${failed} failed) · package version ${PACKAGE_VERSION}`);

  if (process.argv.includes("--push")) {
    // The Worker stores the row it is given, so send the whole row.
    const full = all<Record<string, unknown>>("SELECT * FROM paragraphs");
    await pushToD1(full);
  }
}

void main();
