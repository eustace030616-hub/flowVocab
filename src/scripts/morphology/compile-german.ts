/**
 * Compile the German morphological tables from data already on disk.
 *
 *   npm run compile:german
 *
 * ## Why tables rather than rules
 *
 * The runtime decided German morphology with suffix rules and proximity heuristics, and the failures
 * were all visible to a reader: `liest` resolved to the noun *Liest*, `kurzen` to *Kurze*, `wächst
 * eine` fused into *einwachsen*, `setzte` into *gegenübersetzen*, `got` and `grew` resolved to
 * nothing. Each fix moved a rule into a table, so the tables are now built deliberately, offline,
 * from sources that state the answer instead of guessing it:
 *
 *   lemma       from Wiktionary's `form_of`, already imported (`import:kaikki`) — 226k mappings
 *   particle    from Wiktionary's verb head template, which spells the separable prefix out
 *   compound    from the lexicon, by requiring every part of a split to be a real word
 *
 * The runtime keeps doing what it does well — a keyed lookup — and stops guessing. Nothing here runs
 * per request; it is a compiler, and its output is reviewable data.
 *
 * ## The particle table, which is the one that mattered
 *
 * German Wiktionary writes a separable verb as `auf.stehen` in the head template, and the expansion
 * confirms it ("third-person singular present steht auf"); an inseparable verb has no dot
 * (`verstehen`). That is a statement about the verb, not a guess about a sentence.
 *
 * The table is also filtered to verbs the reader can actually explain: a merged form with no
 * translation is worse than not merging, because the learner is left with a word the app cannot
 * gloss. That single condition is what would have caught `gegenübersetzen`, a real but unglossed verb
 * that the proximity heuristic invented from "setzte … gegenüber".
 */

import { createGunzip } from "node:zlib";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import { connectDB } from "../../lib/db";
import { Word } from "../../models/Word";
import { Gloss } from "../../models/Gloss";
import { Inflection } from "../../models/Inflection";
import { Separation } from "../../models/Separation";
import { Compound } from "../../models/Compound";
import { lemmaKeyOf } from "../../lib/tokenize/normalize";
import { runIfEntry } from "../run";

const SOURCE = "wiktionary-de-morphology";
const KAIKKI = path.join(process.cwd(), "data", "de", "kaikki-de.jsonl.gz");

/** The longest a German prefix gets: `gegenüber`, `auseinander`, `entgegen`. */
const MAX_PARTICLE_LENGTH = 12;
const MIN_PART_LENGTH = 4;

interface KaikkiLine {
  word?: unknown;
  pos?: unknown;
  head_templates?: Array<{ name?: string; args?: Record<string, string> }>;
}

/**
 * The separable prefix of a verb, from Wiktionary's own notation.
 *
 * `de-verb` takes an argument like `auf.stehen<stand,gestanden>` or `ein.kaufen`; the dot is the
 * boundary. A template with no dot is an inseparable verb, and one that is missing or malformed is
 * treated as inseparable — the conservative direction, because the runtime falls back to the plain
 * verb, which is at least a word the reader can be shown.
 */
export function separablePrefix(templates: KaikkiLine["head_templates"]): {
  particle: string;
  verb: string;
} | null {
  for (const template of templates ?? []) {
    if (template?.name !== "de-verb") continue;
    const raw = template.args?.["1"];
    if (typeof raw !== "string") continue;
    // Strip the angle-bracket inflection spec before looking for the boundary.
    const head = raw.split("<")[0].trim();
    const dot = head.indexOf(".");
    if (dot <= 0) return null;
    const particle = head.slice(0, dot).toLowerCase();
    const verb = head.slice(dot + 1).toLowerCase();
    if (!particle || !verb || particle.length > MAX_PARTICLE_LENGTH) return null;
    return { particle, verb };
  }
  return null;
}

/**
 * Split a compound so that every part is a word the vocabulary holds, longest head first.
 *
 * Head-final, so the last element carries the meaning and is preferred when several splits are
 * possible. Two parts only: German compounds of three or more elements are rare enough that
 * mis-splitting them costs more than leaving them whole.
 */
export function lexiconSplit(form: string, vocabulary: Set<string>): string[] | null {
  if (form.length < MIN_PART_LENGTH * 2) return null;
  let best: string[] | null = null;
  for (let cut = MIN_PART_LENGTH; cut <= form.length - MIN_PART_LENGTH; cut += 1) {
    const left = form.slice(0, cut);
    const right = form.slice(cut);
    if (!vocabulary.has(left) || !vocabulary.has(right)) continue;
    if (!best || right.length > best[1].length) best = [left, right];
  }
  return best;
}

async function main() {
  if (!existsSync(KAIKKI)) {
    throw new Error(`missing ${path.relative(process.cwd(), KAIKKI)} — run src/scripts/import/fetch-data.sh --full`);
  }

  console.log("compile German morphology → runtime tables");
  console.log("────────────────────────────────────────");
  await connectDB();

  // The vocabulary, so a table can be filtered to words the reader can actually be shown.
  const words = await Word.find({ targetLang: "de", origin: "import" }).select("lemmaKey").lean();
  const vocabulary = new Set(words.map((w) => w.lemmaKey));
  const glossed = new Set((await Gloss.distinct("lemmaKey", { targetLang: "de", lang: "en" })).map(String));
  console.log(`  vocabulary   ${vocabulary.size.toLocaleString()} German lemmas, ${glossed.size.toLocaleString()} glossed`);

  const separations = new Map<string, { particle: string; verb: string; merged: string }>();
  const compounds = new Map<string, string[]>();

  const rl = createInterface({
    input: createReadStream(KAIKKI).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let lines = 0;
  let dotted = 0;
  for await (const line of rl) {
    lines += 1;
    if (lines % 250_000 === 0) {
      process.stdout.write(`\r  reading… ${lines.toLocaleString()} lines · ${separations.size} separable verbs`);
    }
    if (!line.includes('"de-verb"')) continue;

    let parsed: KaikkiLine;
    try {
      parsed = JSON.parse(line) as KaikkiLine;
    } catch {
      continue;
    }
    if (parsed.pos !== "verb" || typeof parsed.word !== "string") continue;

    const split = separablePrefix(parsed.head_templates);
    if (!split) continue;
    dotted += 1;

    const merged = lemmaKeyOf(parsed.word);
    // Keep a separation only when the merged verb exists for the reader and can be translated. A
    // merge into an unglossed rare verb is a worse answer than the plain verb.
    if (!vocabulary.has(merged) || !glossed.has(merged)) continue;
    if (!vocabulary.has(split.verb)) continue;

    separations.set(`${split.particle}\u0000${split.verb}`, {
      particle: split.particle,
      verb: split.verb,
      merged,
    });

    // The same entry is also a compound candidate: a separable verb's parts are words.
    const parts = lexiconSplit(merged, vocabulary);
    if (parts) compounds.set(merged, parts);
  }
  process.stdout.write("\n");
  console.log(`  parsed       ${lines.toLocaleString()} lines · ${dotted.toLocaleString()} with a separable prefix`);
  console.log(`  particles    ${separations.size.toLocaleString()} usable (particle, verb) pairs`);

  // Nouns and other compounds: every vocabulary lemma that splits into two known words and is not
  // already a separable verb.
  for (const lemma of vocabulary) {
    if (compounds.has(lemma)) continue;
    const parts = lexiconSplit(lemma, vocabulary);
    if (parts) compounds.set(lemma, parts);
  }
  console.log(`  compounds    ${compounds.size.toLocaleString()} forms with a lexicon-valid split`);

  await Separation.deleteMany({ targetLang: "de" });
  await Compound.deleteMany({ targetLang: "de" });

  const sepOps = [...separations.values()].map((row) => ({
    updateOne: {
      filter: { targetLang: "de", particle: row.particle, verb: row.verb },
      update: { $set: { merged: row.merged, source: SOURCE } },
      upsert: true,
    },
  }));
  if (sepOps.length) await Separation.bulkWrite(sepOps, { ordered: false });

  const compoundOps = [...compounds.entries()].map(([form, parts]) => ({
    updateOne: {
      filter: { targetLang: "de", form },
      update: { $set: { parts, source: SOURCE } },
      upsert: true,
    },
  }));
  if (compoundOps.length) await Compound.bulkWrite(compoundOps, { ordered: false });

  console.log(
    `  stored       ${await Separation.countDocuments({ targetLang: "de" })} separations · ` +
      `${await Compound.countDocuments({ targetLang: "de" })} compounds`,
  );
  const inflections = await Inflection.countDocuments({ targetLang: "de" });
  console.log(`  inflections  ${inflections.toLocaleString()} already in place from import:kaikki`);
}

runIfEntry(import.meta.url, main);
