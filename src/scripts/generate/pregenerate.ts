/**
 * Write passages ahead of time, so the button never makes anyone wait.
 *
 *   npm run pregenerate -- --count 3                 # three for each track's likely level
 *   npm run pregenerate -- --count 2 --lang de --level A2
 *
 * The stock is ordinary paragraphs flagged `buffered`. Serving one clears the flag, so it appears in
 * history exactly once and the next press takes the next buffered passage. Generation is a few
 * seconds now, but "press and wait" is a worse experience than "press and read", and a buffer is the
 * difference between the two.
 */

import { connectDB } from "../../lib/db";
import { abilityFor, anyAbilityUser } from "../../lib/store/learner";
import { countBuffered, markBufferedByBrief, paragraphByBrief } from "../../lib/store/content";
import { targetBriefLevel } from "../../lib/learner/band";
import { briefIdOf, onDemandBrief } from "./briefs";
import { deepseekProvider, describeProvider } from "./provider";
import { generateOne, importParagraph } from "./generate";
import { assertShippable } from "../../lib/licence/datasets";
import type { CefrLevel, TargetLang } from "../../lib/lang";
import { runIfEntry } from "../run";

/** How much stock to keep per language. */
export const BUFFER_TARGET = 2;

function argOf(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** The level to write for: one band above the learner's estimate, the same rule the button uses. */
export async function levelFor(userId: string, targetLang: TargetLang): Promise<CefrLevel> {
  const ability = abilityFor(userId, targetLang);
  return targetBriefLevel(ability?.theta ?? 0.25);
}

/**
 * Top the stock back up. Returns how many were written.
 *
 * Called by the generate route after serving a buffered passage, and by the script. The brief id is
 * unique per passage, so stocking never overwrites anything.
 */
/**
 * Which levels are currently being refilled.
 *
 * The dedupe belongs here rather than on the request path: a press must generate its own passage, but
 * ten presses in a row should not each start a *stocking* loop that generates `BUFFER_TARGET` more.
 * One refill per language and level at a time; the next press extends it.
 */
const refilling = new Set<string>();

export async function refillBuffer(
  userId: string,
  targetLang: TargetLang,
  wanted = BUFFER_TARGET,
): Promise<number> {
  const already = countBuffered(targetLang);
  if (already >= wanted) return 0;

  const level = await levelFor(userId, targetLang);
  const key = `${targetLang}:${level}`;
  if (refilling.has(key)) return 0;
  refilling.add(key);
  try {
    return await stock(key);
  } finally {
    refilling.delete(key);
  }

  async function stock(_key: string): Promise<number> {
  const provider = deepseekProvider();
  let written = 0;

  for (let i = already; i < wanted; i += 1) {
    const spec = {
      ...onDemandBrief(targetLang, level),
      briefId: `buffered:${targetLang}:${Date.now().toString(36)}:${i}`,
    };
    const outcome = await generateOne(provider, spec, {
      deadlineMs: 30_000,
      onAttempt: (line) => console.log(line),
    });
    if (!outcome.passed) continue;
    await importParagraph(outcome);
    markBufferedByBrief(targetLang, spec.briefId);
    written += 1;
  }
  return written;
  }
}

async function main() {
  assertShippable("deepseek-generated");
  await connectDB();
  const provider = deepseekProvider();
  const count = Number(argOf("--count") ?? BUFFER_TARGET);
  const langs: TargetLang[] = argOf("--lang") ? [argOf("--lang") as TargetLang] : ["de", "en"];

  console.log("pregenerating passages");
  console.log("──────────────────────");
  console.log(describeProvider(provider));

  // Stock belongs to nobody in particular, so the level comes from the first learner who has one,
  // falling back to A2 — the same clamp the button uses.
  const anyUser = anyAbilityUser();

  for (const lang of langs) {
    const explicitLevel = argOf("--level") as CefrLevel | undefined;
    const level = explicitLevel ?? (await levelFor(anyUser, lang));
    const existing = countBuffered(lang);
    let written = 0;
    for (let i = 0; i < count; i += 1) {
      const spec = {
        ...onDemandBrief(lang, level),
        briefId: `buffered:${lang}:${Date.now().toString(36)}:${i}`,
      };
      const outcome = await generateOne(provider, spec, { deadlineMs: 30_000, onAttempt: (l) => console.log(l) });
      if (!outcome.passed) {
        console.log(`    ${lang}: rejected — ${outcome.issues[0] ?? "unknown"}`);
        continue;
      }
      await importParagraph(outcome);
      markBufferedByBrief(lang, spec.briefId);
      written += 1;
    }
    console.log(`  ${lang} ${level}: wrote ${written}, stock now ${existing + written}`);
  }
}

runIfEntry(import.meta.url, main);
