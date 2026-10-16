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
  /** Target length in words for the whole passage, which the rubric bounds too. */
  words: number;
  /**
   * How many paragraphs to write.
   *
   * Three: a scene, a complication, a resolution. Four is allowed by the rubric (the model may need
   * the room) but three is what the prompt asks for, because a four-paragraph ask at a controlled
   * vocabulary usually buys a thin last paragraph rather than a better story.
   */
  paragraphs?: number;
  /**
   * Identity for the paragraph this brief produces, when it should not be replaced.
   *
   * Curated briefs upsert by `briefIdOf`, so regenerating one replaces it. The button must instead
   * add a paragraph every time — which is what "no limit" means — so the route supplies a unique id.
   * Without it, a drawn topic that matched a curated brief silently replaced that paragraph instead
   * of adding one, and pressing the button appeared to do nothing.
   */
  briefId?: string;
  /**
   * How many known words to offer as a register to aim at.
   *
   * Raised from 15 when passages became three paragraphs: a register for a 90-word text is not a
   * register for a 300-word one, and a thin list is what pushes the writer above the level.
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
    words: 160,
    paragraphs: 2,
    coreSize: 25,
  },
  {
    targetLang: "de",
    level: "B1",
    topic: "The train is late and a stranger explains why it is worth the wait",
    words: 330,
    paragraphs: 3,
    coreSize: 25,
  },
  {
    targetLang: "de",
    level: "B2",
    topic: "A short account of moving to a new city and what was hardest about it",
    words: 390,
    paragraphs: 3,
    coreSize: 25,
  },
  // English, for the Chinese-speaking track.
  {
    targetLang: "en",
    level: "A2",
    topic: "A lost dog comes back three days later, cleaner than when it left",
    words: 160,
    paragraphs: 2,
    coreSize: 25,
  },
  {
    targetLang: "en",
    level: "B1",
    topic: "Why a small town decided to close its main street to cars",
    words: 330,
    paragraphs: 3,
    coreSize: 25,
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

/**
 * Topics for generation on demand.
 *
 * The curated BRIEFS are the acceptance set — fixed level, fixed topic, so a change in the generator
 * can be compared against the same targets. These are for the button: pressing it should produce
 * something new every time, so the topic is drawn from a pool and each press makes a new brief, and
 * therefore a new paragraph, with no limit.
 *
 * Every entry has to be a scene that can be told in the level's vocabulary: something happens, there
 * is a small stake, and the words it needs are everyday ones. A topic whose natural vocabulary is
 * above the level is the failure mode the German A2 brief already demonstrated.
 */
export const TOPIC_POOL: Record<TargetLang, readonly string[]> = {
  de: [
    "It starts to rain and you have no umbrella",
    "A parcel arrives at the wrong door",
    "The baker has sold out of bread by nine",
    "You find a wallet on the pavement",
    "A neighbour's cat waits at your window every morning",
    "The lift is broken and you live on the fifth floor",
    "You forget your keys and wait for a friend",
    "A small boy asks you the way to the station",
    "The coffee machine at work stops working",
    "You miss the last bus home",
    "A friend gives you a plant and it grows too fast",
    "The market moves to a different square",
  ],
  en: [
    "A shop closes and the street feels different",
    "You find a book with a name written inside",
    "The bus driver waits for a late passenger",
    "A cat follows you home twice in one week",
    "Your phone dies in the middle of the day",
    "A neighbour returns a tool you lent them",
    "The last train leaves earlier than the sign says",
    "You plant seeds and only one of them grows",
    "An old photograph falls out of a library book",
    "A small shopkeeper remembers your order",
    "The road is closed and everyone takes the same detour",
    "A stranger returns a glove you dropped",
  ],
};

/** A brief for the generator's button: this language, the learner's level, a fresh topic. */
export function onDemandBrief(
  targetLang: TargetLang,
  level: CefrLevel,
  topic?: string,
): BriefSpec {
  const pool = TOPIC_POOL[targetLang];
  const chosen = topic ?? pool[Math.floor(Math.random() * pool.length)];
  return {
    targetLang,
    level,
    topic: chosen,
    // Whole-passage length: three paragraphs of roughly 90-130 words, which the rubric bounds.
    // Three paragraphs, but a total the level's vocabulary can sustain: A2 at 300 words measured
    // 91-92% coverage per paragraph against a 93% floor, because the words to fill 300 words at A2 do
    // not exist at A2. That is a fact about the level, not a fault in the text.
    words: level === "A2" ? 160 : level === "B1" ? 330 : 390,
    paragraphs: level === "A2" ? 2 : 3,
    coreSize: 25,
  };
}
