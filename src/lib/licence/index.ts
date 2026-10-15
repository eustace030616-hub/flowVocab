/**
 * Licence plumbing.
 *
 * Emits, from the dataset catalogue, everything a licence review needs:
 *
 *   LICENSES/MANIFEST.md      human-readable table + per-dataset attribution
 *   LICENSES/provenance.json  machine-readable, for regenerating the byte lineage of a build
 *   LICENSES/<dataset>.txt    the attribution string + licence text (or a pointer to it)
 *
 * The point is that attribution is *generated from data* rather than hand-maintained — the
 * failure mode this avoids is shipping a build whose notices no longer match its contents.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DATASETS,
  dataset,
  restrictedDatasets,
  shippableDatasets,
  type DatasetSpec,
} from "./datasets";

export { DATASETS, dataset, restrictedDatasets, shippableDatasets };
export type { DatasetSpec };

export const LICENSES_DIR = path.join(process.cwd(), "LICENSES");

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Try to fetch the verbatim licence text. Optional: a build with no network still produces a
 * valid manifest, it just points at the licence URL instead of embedding the text.
 */
async function fetchLicenceText(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    // Licence pages are HTML; keep it short and honest rather than storing a whole page.
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, 8000) || null;
  } catch {
    return null;
  }
}

export interface ManifestResult {
  dir: string;
  written: string[];
  datasets: number;
  shippable: number;
  restricted: number;
  offlineOnly: number;
}

export async function writeLicenceManifest(options: {
  dir?: string;
  fetchText?: boolean;
  retrievedAt?: Date;
} = {}): Promise<ManifestResult> {
  const dir = options.dir ?? LICENSES_DIR;
  const retrievedAt = options.retrievedAt ?? new Date();
  await mkdir(dir, { recursive: true });

  const specs = Object.values(DATASETS);
  const written: string[] = [];

  for (const spec of specs) {
    const lines = [
      `${spec.title}`,
      `${"=".repeat(spec.title.length)}`,
      "",
      `Dataset id : ${spec.dataset}`,
      `Source     : ${spec.url}`,
      `Licence    : ${spec.license}`,
      spec.licenseUrl ? `Licence URL: ${spec.licenseUrl}` : null,
      `Commercial : ${spec.commercialUse ? "yes" : "NO"}`,
      `Share-alike: ${spec.shareAlike ? "yes" : "no"}`,
      `Copyleft   : ${spec.copyleft ? "yes" : "no"}`,
      `Offline only: ${spec.offlineOnly ? "YES — must never ship" : "no"}`,
      "",
      "Attribution (use verbatim):",
      `  ${spec.attribution}`,
      "",
      "Contributes to:",
      ...spec.contributesTo.map((c) => `  - ${c}`),
      spec.notes ? `\nNotes:\n  ${spec.notes}` : "",
      "",
    ].filter((l): l is string => l !== null);

    if (options.fetchText && spec.licenseUrl) {
      const text = await fetchLicenceText(spec.licenseUrl);
      if (text) {
        lines.push("Verbatim licence text (retrieved):", "", text, "");
      } else {
        lines.push(
          `Full licence text: not retrieved. Consult ${spec.licenseUrl}`,
          "",
        );
      }
    } else if (spec.licenseUrl) {
      lines.push(`Full licence text: see ${spec.licenseUrl}`, "");
    }

    const file = path.join(dir, `${spec.dataset}.txt`);
    await writeFile(file, lines.join("\n"), "utf8");
    written.push(path.basename(file));
  }

  const shippable = shippableDatasets();
  const restricted = restrictedDatasets();
  const offline = specs.filter((d) => d.offlineOnly);

  const manifest = [
    "# Data sources and licences",
    "",
    `Generated ${retrievedAt.toISOString()} from \`src/lib/licence/datasets.ts\`.`,
    "",
    `Datasets: ${specs.length} · shippable: ${shippable.length} · share-alike or copyleft: ${restricted.length} · offline-only: ${offline.length}`,
    "",
    "## Shippable in a commercial build",
    "",
    "| Dataset | Licence | Commercial | Share-alike | Copyleft |",
    "|---|---|---|---|---|",
    ...shippable.map(
      (d) =>
        `| ${d.title} | ${d.license} | ${d.commercialUse ? "yes" : "no"} | ${d.shareAlike ? "yes" : "no"} | ${d.copyleft ? "yes" : "no"} |`,
    ),
    "",
    "### Attribution strings (reproduce these verbatim in the product)",
    "",
    ...shippable.map((d) => `- **${d.title}** — ${d.attribution}`),
    "",
    "## Offline calibration only — never committed, shipped, or imported",
    "",
    ...offline.map((d) => `- **${d.title}** — ${d.license}. ${d.notes ?? ""}`.trim()),
    "",
    "## Combining rules",
    "",
    "Share-alike and copyleft data must stay in its own collection. Merging licensed gloss text",
    "into a collection with proprietary text makes the whole collection an adaptation that must",
    "itself be licensed under the same terms. Rebuild merged lookup views at startup instead of",
    "materialising one combined lexicon.",
    "",
  ].join("\n");

  await writeFile(path.join(dir, "MANIFEST.md"), manifest, "utf8");
  written.push("MANIFEST.md");

  const provenance = {
    generatedAt: retrievedAt.toISOString(),
    generatedFrom: "src/lib/licence/datasets.ts",
    counts: {
      total: specs.length,
      shippable: shippable.length,
      restricted: restricted.length,
      offlineOnly: offline.length,
    },
    datasets: specs.map((d) => ({
      dataset: d.dataset,
      title: d.title,
      url: d.url,
      license: d.license,
      licenseUrl: d.licenseUrl ?? null,
      attribution: d.attribution,
      commercialUse: d.commercialUse,
      shareAlike: d.shareAlike,
      copyleft: d.copyleft,
      offlineOnly: d.offlineOnly,
      contributesTo: d.contributesTo,
    })),
  };

  await writeFile(
    path.join(dir, "provenance.json"),
    JSON.stringify(provenance, null, 2),
    "utf8",
  );
  written.push("provenance.json");

  return {
    dir,
    written,
    datasets: specs.length,
    shippable: shippable.length,
    restricted: restricted.length,
    offlineOnly: offline.length,
  };
}

/** Plain documents for upserting into the Provenance collection. */
export function provenanceDocs(retrievedAt: Date = new Date()) {
  return Object.values(DATASETS).map((d) => ({
    dataset: d.dataset,
    title: d.title,
    url: d.url,
    license: d.license,
    licenseUrl: d.licenseUrl,
    attribution: d.attribution,
    commercialUse: d.commercialUse,
    shareAlike: d.shareAlike,
    copyleft: d.copyleft,
    offlineOnly: d.offlineOnly,
    contributesTo: d.contributesTo,
    notes: d.notes,
    retrievedAt,
  }));
}
