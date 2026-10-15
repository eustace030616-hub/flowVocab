/**
 * The briefs the generator fulfils.
 *
 * Each is a (language, level, topic) promise about what the text will be. The level is not a label
 * applied afterwards — it is the acceptance target the rubric measures against, and a text that
 * misses it is rejected rather than relabelled.
 *
 * Topics are chosen to be self-contained scenes rather than schoolbook themes: something happens,
 * there is a small stake, and the vocabulary needed is everyday and glossable.
 */

import type { CefrLevel, TargetLang } from "../../lib/lang";

export interface BriefSpec {
  targetLang: TargetLang;
  level: CefrLevel;
  topic: string;
  /** Target length in words, which the rubric bounds too. */
  words: number;
  /**
   * How many known words to offer as a register to aim at.
   *
   * Small on purpose. A large list is an instruction to write a large number of unrelated sentences;
   * fifty-five words produced exactly that.
   */
  coreSize: number;
}

export const BRIEFS: BriefSpec[] = [
  // German. A2 first: concrete, present tense, small vocabulary.
  {
    targetLang: "de",
    level: "A2",
    // Chosen for A2 vocabulary, not just A2 grammar. The first topic — watering a neighbour's plants
    // — needs *gießen* and *Pflanze*, which the difficulty data places above A2, so the brief was
    // asking for a level of language the level does not have. The model's own topic-word proposals
    // for it scored 0 usable out of 15. Rain, a bus and no umbrella is a scene A2 can tell.
    topic: "It starts to rain and you have no umbrella",
    words: 90,
    coreSize: 15,
  },
  {
    targetLang: "de",
    level: "B1",
    topic: "The train is late and a stranger explains why it is worth the wait",
    words: 110,
    coreSize: 15,
  },
  {
    targetLang: "de",
    level: "B2",
    topic: "A short account of moving to a new city and what was hardest about it",
    words: 130,
    coreSize: 15,
  },
  // English, for the Chinese-speaking track.
  {
    targetLang: "en",
    level: "A2",
    topic: "A lost dog comes back three days later, cleaner than when it left",
    words: 90,
    coreSize: 15,
  },
  {
    targetLang: "en",
    level: "B1",
    topic: "Why a small town decided to close its main street to cars",
    words: 110,
    coreSize: 15,
  },
];

/** A stable key for a brief: what identity means for a generated paragraph. */
export function briefIdOf(spec: BriefSpec): string {
  const slug = spec.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-");
  return `${spec.targetLang}:${spec.level}:${slug}`;
}
