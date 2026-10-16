/**
 * Building the generation prompt, and reading what comes back.
 *
 * The prompt is where difficulty is controlled, and the first version of it controlled the wrong
 * thing. It handed the model a large randomly-sampled word list and told it to build from the list,
 * which is a rational instruction that produces irrational text: fifty unrelated words can only be
 * satisfied by fifty unrelated sentences. The result passed the rubric — right length, right
 * coverage, every word glossed — and read like this:
 *
 *     Der Zug ist spät. Ein Fremder sagt: „Das ist gut. Im Bezirk gibt es eine Tanzgruppe.
 *     Sie tanzt am Abgrund. Anscheinend studieren sie Physik. … Ein türkischer Schuster geht
 *     ins Hallenbad.
 *
 * So the list is now *small and advisory* rather than large and compulsory. Difficulty comes from
 * measuring the result and asking for specific simplifications, not from pre-committing the model to
 * a word list — and coherence is checked separately, because no amount of difficulty measurement
 * notices that a text is nonsense.
 *
 * The two lists still have different jobs:
 *
 *   core     a handful of words just below the level, offered as a register to aim at. Advisory.
 *   target   a *pool* of new words at the level. The model chooses a handful that fit the scene it
 *            writes. Forcing every word in the pool to appear was the second half of the same bug:
 *            eight randomly-sampled words at the right difficulty are still eight unrelated concepts,
 *            and a short scene cannot contain them all. i+1 needs a few unfamiliar words, not
 *            specifically these ones — the rubric's coverage band is what guarantees there are some.
 *
 * Pure — no network, no database — so the shaping rules and the response parsing are tested.
 */

import type { CefrLevel, TargetLang } from "../../lib/lang";

export interface VocabularyItem {
  word: string;
  gloss: string | null;
}

export interface Brief {
  targetLang: TargetLang;
  level: CefrLevel;
  /** What the text is about, in the learner's own frame of reference. */
  topic: string;
  /** Target length in words, for the whole passage. */
  words: number;
  /** How many paragraphs to write. Three or four is a scene with room for a turn. */
  paragraphs?: number;
  core: VocabularyItem[];
  target: VocabularyItem[];
}

/** Language names as a model expects to see them, and the language it must not write in. */
const LANGUAGE: Record<TargetLang, { name: string; gloss: string }> = {
  de: { name: "German", gloss: "English" },
  en: { name: "English", gloss: "Chinese" },
};

export function buildSystemPrompt(brief: Brief): string {
  const { name, gloss } = LANGUAGE[brief.targetLang];
  return [
    `You write short reading passages for a language learner: ${name}, level ${brief.level}.`,
    `Glosses in the CORE and TARGET lists are given in ${gloss} for your information only — never write a word of ${gloss} in the passage.`,
    "",
    "The passage must be ONE connected text, not a sequence of sentences:",
    "- A single small scene or event, with a beginning and an end.",
    "- Every sentence must follow from the one before it. If a sentence could be moved anywhere else",
    "  in the passage without changing anything, it does not belong.",
    "",
    `Structure it as exactly ${brief.paragraphs ?? 3} substantial paragraphs — about ` +
      `${Math.round(brief.words / (brief.paragraphs ?? 3))} words each, not three short ones — ` +
      `and give each one a job:`,
    "- Paragraph 1 sets the scene: who, where, and what is already true.",
    "- Paragraph 2 introduces the complication: the thing that goes wrong or is missing.",
    "- Paragraph 3 (and 4, if you write four) resolves it, and the last sentence ends the scene.",
    "",
    "Across paragraphs:",
    "- Each paragraph must move the story forward. A paragraph that only restates what the reader",
    "  already knows is wrong even if its sentences are all correct.",
    "- Do not repeat a sentence, and do not open consecutive paragraphs the same way.",
    "- Keep the same people and place throughout. No new characters in the last paragraph.",
    `- Each paragraph should be roughly ${Math.round((brief.paragraphs ? brief.words / brief.paragraphs : brief.words) / 25) * 25} words: four to eight sentences of ordinary length.`,
    "  A paragraph of one or two sentences is a fragment, not a paragraph.",
    "- Concrete and ordinary: something happens, someone does something, there is a small outcome.",
    "- At most one short quotation, and never the whole passage inside quotation marks.",
    "- No lists of unrelated facts, no abrupt changes of subject, no absurd combinations.",
    "",
    "Language:",
    "- Prefer the simplest word that says what you mean. Simpler is better than more precise.",
    `- Build the register from the CORE words where they fit naturally; they are advisory, not compulsory.`,
    "- The TARGET list is a pool of new words at this level. Choose the five to eight that fit the",
    "  scene you write, and use each one where its meaning is clear from the context. Leave the rest.",
    "- Short sentences. No idioms, no wordplay, no metaphors.",
    "- If the scene needs a word that is too advanced, change what happens in the scene rather than",
    "  forcing an awkward phrase to avoid it. A simpler event told naturally beats a strained one.",
    "",
    "Reply with JSON only, no code fences:",
    `{"title": "short title", "paragraphs": ["first paragraph", "second", "third"]}`,
  ].join("\n");
}

/**
 * The coherence judge.
 *
 * A second call, because the objective rubric cannot see this. It measured a passage at exactly the
 * right difficulty, length and gloss coverage whose sentences were unrelated to each other — every
 * measurable property was correct and the text was still unreadable. Difficulty is arithmetic;
 * "is this a text" is a judgement, and a judgement needs a reader.
 *
 * The judge is asked for specific problems rather than a score, so its answer can be fed straight
 * back into the repair step.
 */
export function buildJudgeSystemPrompt(targetLang: TargetLang): string {
  const { name } = LANGUAGE[targetLang];
  return [
    `You review short ${name} reading passages written for language learners.`,
    "You are not checking grammar or difficulty — only whether it is a coherent text.",
    "",
    "Fail a passage if any of these is true:",
    "- Its sentences are unrelated to each other; the order could be shuffled without loss.",
    "- It changes subject abruptly, or piles up unrelated facts.",
    "- A paragraph restates what an earlier paragraph already said, or the passage never gets",
    "  anywhere: the same situation repeated three times is not a passage.",
    "- It stops without resolving anything, or introduces a new person or place in the last",
    "  paragraph that the rest of the text has not prepared.",
    "- Paragraphs are wildly different in length or difficulty, so one reads like a different text.",
    "- It contains combinations that are absurd or meaningless even if grammatical.",
    "- The language is stilted or unnatural: a phrase no native speaker would write, a word used with",
    "  the wrong meaning, or a sentence that only exists to place a word. Simple is fine; odd is not.",
    "- **It describes an ordinary thing instead of naming it.** This is the failure to look for",
    "  hardest. A writer held to a small vocabulary will avoid a word it thinks is too hard and",
    "  explain the object instead — \"a device for protection\" for an umbrella, \"a thing for the",
    "  rain\" for a coat. To the writer that looks like obeying the constraint; to a reader it is",
    "  broken language, because no native speaker says it. For each object the text describes,",
    "  ask yourself what the ordinary word is. If the text went around it, fail the passage and say",
    "  which phrase is the problem.",
    "- The whole passage is one long quotation, or a list rather than a scene.",
    "",
    "Pass it if a patient reader would accept it as a short, simple, connected text.",
    "Reply with JSON only, no code fences:",
    '{"coherent": true, "problems": ["specific problem", "..."]}',
  ].join("\n");
}

export function buildJudgeUserPrompt(content: string): string {
  return `Passage:\n\n${content}`;
}

export interface JudgeVerdict {
  coherent: boolean;
  problems: string[];
}

/** Read the judge's reply, defaulting to "pass" when it is unusable — the rubric already gated it. */
export function parseJudge(text: string): JudgeVerdict {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate) as { coherent?: unknown; problems?: unknown };
    const problems = Array.isArray(parsed.problems)
      ? parsed.problems.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    // "Not coherent" with no stated problem is not actionable, so it is treated as a pass rather
    // than looping on a complaint the model cannot fix.
    if (parsed.coherent === false && problems.length > 0) return { coherent: false, problems };
    return { coherent: true, problems: [] };
  } catch {
    return { coherent: true, problems: [] };
  }
}

function list(items: VocabularyItem[]): string {
  return items
    .map((item) => (item.gloss ? `${item.word} (${item.gloss})` : item.word))
    .join(", ");
}

export function buildUserPrompt(brief: Brief, feedback?: string[]): string {
  const parts = [
    `Topic: ${brief.topic}`,
    `Length: about ${brief.words} words in total, across ${brief.paragraphs ?? 3} paragraphs — ` +
      `roughly ${Math.round(brief.words / (brief.paragraphs ?? 3))} words each.`,
    "",
    `CORE vocabulary (the reader already knows these — build the passage from them):\n${list(brief.core)}`,
    "",
    `TARGET vocabulary (new words at this level — choose five to eight that fit):\n${list(brief.target)}`,
  ];

  if (feedback?.length) {
    // The repair step. Specific complaints are what make a second attempt different from the first.
    parts.push(
      "",
      "Your previous attempt was measured and rejected. Fix exactly these problems:",
      ...feedback.map((issue) => `- ${issue}`),
      "",
      "Replace harder words with ones from the CORE list rather than deleting content, and keep every TARGET word.",
    );
  }

  return parts.join("\n");
}

/**
 * Ask the model which words the topic needs, so the operator's list is not the only source.
 *
 * The German A2 brief failed on coherence while passing the difficulty rubric, with a scene whose
 * key verb had been replaced by an awkward paraphrase ("Mach meine Blumen nass" for *gießen*). The
 * cause was the vocabulary I supplied: sampled randomly from below the level, it happened not to
 * contain the words that talking about watering plants requires, so the model used what it had.
 *
 * The model is the right party to name those words and the wrong party to judge whether they are
 * simple enough. So it proposes and the data disposes: everything it suggests is looked up and kept
 * only if it is at or below the level and has a gloss.
 */
export function buildTopicVocabularyPrompt(
  targetLang: TargetLang,
  level: CefrLevel,
  topic: string,
): { system: string; user: string } {
  const { name } = LANGUAGE[targetLang];
  return {
    system: [
      `You list vocabulary for ${name} reading passages at level ${level}.`,
      "Reply with JSON only, no code fences.",
      '{"words": ["word", "word"]}',
    ].join("\n"),
    user: [
      `Topic: ${topic}`,
      "",
      `List 15 ${name} words that a passage on this topic would need — the nouns, verbs and`,
      "adjectives that carry the scene, not function words.",
      `Use only words an ${level} learner would meet. Prefer the simplest word that means it.`,
      "Give the dictionary form: nouns with their article, verbs in the infinitive.",
    ].join("\n"),
  };
}

/** Read the proposed word list, tolerating fences and prose around the JSON. */
export function parseTopicVocabulary(text: string): string[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate) as { words?: unknown };
    if (!Array.isArray(parsed.words)) return [];
    return parsed.words
      .filter((w): w is string => typeof w === "string")
      .map((w) => w.trim())
      .filter((w) => w.length > 0 && w.length < 40)
      .slice(0, 20);
  } catch {
    return [];
  }
}

export interface GeneratedParagraph {
  title: string;
  content: string;
}

/**
 * Read the model's reply.
 *
 * Tolerates the two ways this reliably goes wrong: a JSON object wrapped in code fences, and prose
 * around the JSON. Falls back to treating the whole reply as the passage, because a formatting slip
 * should not waste a generation — the rubric decides whether the text is usable.
 */
export function parseGenerated(text: string): GeneratedParagraph | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const candidates = [withoutFences];
  const first = withoutFences.indexOf("{");
  const last = withoutFences.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(withoutFences.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        title?: unknown;
        content?: unknown;
        paragraphs?: unknown;
      };
      // The array form is what the prompt now asks for: it makes the paragraph structure explicit
      // rather than something inferred from blank lines, which a model may or may not emit.
      const fromArray = Array.isArray(parsed.paragraphs)
        ? parsed.paragraphs.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [];
      const content = fromArray.length
        ? fromArray.map((p) => p.trim()).join("\n\n")
        : typeof parsed.content === "string"
          ? parsed.content.trim()
          : "";
      if (!content) continue;
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      return { title: title || "Untitled", content };
    } catch {
      // Not JSON; the next candidate, or the fallback below.
    }
  }

  // A reply that was cut off mid-JSON is still a usable passage: the content field is what matters,
  // and the model reached it before running out of budget. Salvaging it costs one regex instead of a
  // whole regeneration — the second most common failure after an empty reply.
  const contentMatch = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(withoutFences);
  if (contentMatch) {
    const salvaged = contentMatch[1]
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();
    if (salvaged.length > 40) {
      const titleMatch = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(withoutFences);
      return {
        title: titleMatch?.[1]?.replace(/\\"/g, '"').trim() || "Untitled",
        content: salvaged,
      };
    }
  }

  // Plain prose: usable, and the title can be derived from it.
  if (withoutFences.length > 40) {
    const firstLine = withoutFences.split("\n")[0].trim();
    const looksLikeJson = withoutFences.startsWith("{");
    if (!looksLikeJson) {
      return { title: firstLine.slice(0, 60) || "Untitled", content: withoutFences };
    }
  }
  return null;
}
