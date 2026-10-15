/**
 * Seed content, as pure data — no database, no models.
 *
 * Split out from seed.ts so the content can be used as a fixture: the German paragraphs below
 * are the cases the old space-split, array-index data model could not represent, and the tests
 * tokenize this exact text to prove they still work.
 */

import type { CefrLevel, GlossLang, TargetLang } from "../lib/lang";
import { lemmaKeyOf } from "../lib/tokenize/normalize";
import type { LemmaLookup } from "../lib/tokenize/rules";

export const SEED_SOURCE = "flowwing-seed-glosses";

export interface SeedGloss {
  lang: GlossLang;
  text: string;
  source: string;
  license: string;
  generated: boolean;
}

export function gloss(lang: GlossLang, text: string): SeedGloss {
  return { lang, text, source: SEED_SOURCE, license: "CC0-1.0", generated: false };
}

export interface SeedWord {
  targetLang: TargetLang;
  lemma: string;
  pos: string;
  level: CefrLevel;
  glosses: SeedGloss[];
  article?: string;
  plural?: string;
  cognateWithEn?: boolean;
  falseFriend?: boolean;
}

export const ENGLISH_WORDS: SeedWord[] = [
  { targetLang: "en", lemma: "meadow", pos: "noun", level: "B2", glosses: [gloss("zh", "草地；牧场")] },
  { targetLang: "en", lemma: "rippling", pos: "adjective", level: "C1", glosses: [gloss("zh", "泛起涟漪的")] },
  { targetLang: "en", lemma: "thicket", pos: "noun", level: "C1", glosses: [gloss("zh", "灌木丛")] },
  { targetLang: "en", lemma: "profound", pos: "adjective", level: "B2", glosses: [gloss("zh", "深刻的；深远的")] },
  { targetLang: "en", lemma: "ephemeral", pos: "adjective", level: "C2", glosses: [gloss("zh", "短暂的；转瞬即逝的")] },
  { targetLang: "en", lemma: "companionship", pos: "noun", level: "B2", glosses: [gloss("zh", "陪伴；友情")] },
  { targetLang: "en", lemma: "reinforcement", pos: "noun", level: "C1", glosses: [gloss("zh", "强化；加强")] },
  { targetLang: "en", lemma: "consistent", pos: "adjective", level: "B1", glosses: [gloss("zh", "一致的；始终如一的")] },
  { targetLang: "en", lemma: "morale", pos: "noun", level: "C1", glosses: [gloss("zh", "士气；斗志")] },
  { targetLang: "en", lemma: "distraction", pos: "noun", level: "B1", glosses: [gloss("zh", "分散注意力的事物")] },
];

export const GERMAN_WORDS: SeedWord[] = [
  { targetLang: "de", lemma: "aufstehen", pos: "verb", level: "A2", glosses: [gloss("en", "to get up, to stand up")] },
  { targetLang: "de", lemma: "verstehen", pos: "verb", level: "A2", glosses: [gloss("en", "to understand")] },
  { targetLang: "de", lemma: "Wortschatz", pos: "noun", level: "B1", article: "der", plural: "Wortschätze", glosses: [gloss("en", "vocabulary")] },
  { targetLang: "de", lemma: "Aufbau", pos: "noun", level: "B1", article: "der", plural: "Aufbauten", glosses: [gloss("en", "build-up, structure")] },
  { targetLang: "de", lemma: "Zusammenarbeit", pos: "noun", level: "B1", article: "die", glosses: [gloss("en", "collaboration, teamwork")] },
  { targetLang: "de", lemma: "zusammenarbeiten", pos: "verb", level: "B1", glosses: [gloss("en", "to work together")] },
  { targetLang: "de", lemma: "Kollege", pos: "noun", level: "A2", article: "der", plural: "Kollegen", glosses: [gloss("en", "colleague")] },
  { targetLang: "de", lemma: "Lösung", pos: "noun", level: "B1", article: "die", plural: "Lösungen", glosses: [gloss("en", "solution")] },
  { targetLang: "de", lemma: "Streit", pos: "noun", level: "B1", article: "der", glosses: [gloss("en", "argument, quarrel")] },
  { targetLang: "de", lemma: "offen", pos: "adjective", level: "A2", glosses: [gloss("en", "open")] },
  { targetLang: "de", lemma: "warm", pos: "adjective", level: "A1", cognateWithEn: true, glosses: [gloss("en", "warm")] },
  // The classic English↔German false friend: Gift is poison, not a present.
  { targetLang: "de", lemma: "Gift", pos: "noun", level: "B1", article: "das", plural: "Gifte", falseFriend: true, glosses: [gloss("en", "poison (NOT a present — false friend of English 'gift')")] },
];

export const SEED_WORDS: SeedWord[] = [...ENGLISH_WORDS, ...GERMAN_WORDS];

export type SeedTopic =
  | "education"
  | "tech"
  | "environment"
  | "work_business"
  | "society_health";

export interface SeedParagraph {
  targetLang: TargetLang;
  title: string;
  content: string;
  topic: SeedTopic;
  level: CefrLevel;
}

export const SEED_PARAGRAPHS: SeedParagraph[] = [
  {
    targetLang: "en",
    title: "The Dog",
    content:
      "The dog ran through the meadow, its fur rippling like wheat in the wind. " +
      "A profound silence followed as it vanished into the thicket, leaving only " +
      "the faint trace of its ephemeral presence.",
    topic: "environment",
    level: "B2",
  },
  {
    targetLang: "en",
    title: "A Loyal Dog",
    content:
      "A well-trained dog can provide companionship and emotional support to its owner. " +
      "Studies show that dog owners tend to have lower blood pressure and reduced stress " +
      "levels, making the dog an ideal partner for mental health improvement.",
    topic: "society_health",
    level: "B1",
  },
  {
    targetLang: "en",
    title: "Dog Training",
    content:
      "Teaching a dog basic commands requires patience and consistency. Positive reinforcement " +
      "is widely regarded as the most effective method for shaping a dog's behaviour, " +
      "as it builds trust between the dog and its handler over time.",
    topic: "education",
    level: "B2",
  },
  {
    targetLang: "en",
    title: "Dogs in the Workplace",
    content:
      "Many tech companies now allow employees to bring their dog to the office. " +
      "A friendly dog roaming the workspace can boost morale and encourage social " +
      "interaction among colleagues, though some worry about allergies and distractions.",
    topic: "work_business",
    level: "B2",
  },
  {
    targetLang: "de",
    title: "Wortschatz aufbauen",
    content:
      "Der Wortschatzaufbau braucht Zeit. Jeden Morgen steht sie früh auf und liest " +
      "einen kurzen Text. Wenn sie ein Wort nicht versteht, klickt sie darauf und " +
      "bekommt sofort eine Erklärung.",
    topic: "education",
    level: "A2",
  },
  {
    targetLang: "de",
    title: "Im Büro",
    content:
      "Im Büro arbeiten viele Kollegen zusammen. Die Zusammenarbeit funktioniert gut, " +
      "weil alle offen miteinander sprechen. Manchmal gibt es Streit, aber am Ende " +
      "findet die Gruppe immer eine Lösung.",
    topic: "work_business",
    level: "B1",
  },
  {
    targetLang: "de",
    title: "Vorsicht, falsche Freunde",
    content:
      "Der Kaffee ist noch warm. Im Garten wächst eine Pflanze, und ihr Gift ist " +
      "gefährlich. Wer Deutsch lernt, verwechselt das Wort oft mit dem englischen " +
      '"gift".',
    topic: "society_health",
    level: "B1",
  },
];

const LEVEL_ORDER: CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function difficultyFromSeedLevel(level: CefrLevel): number {
  return (LEVEL_ORDER.indexOf(level) + 0.5) / LEVEL_ORDER.length;
}

/**
 * A lookup over the seed vocabulary, so the tokenizer can be exercised against exactly the
 * content and vocabulary the demo app will use — without a database.
 */
export function seedLexicon(targetLang?: TargetLang): LemmaLookup {
  const keys = new Set(
    SEED_WORDS.filter((w) => !targetLang || w.targetLang === targetLang).map((w) =>
      lemmaKeyOf(w.lemma),
    ),
  );
  return (candidate: string) => keys.has(candidate);
}
