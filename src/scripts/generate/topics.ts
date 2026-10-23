/**
 * What a passage can be about, per language and level.
 *
 * The briefs are five crafted scenarios — one per language and level — and every request reused the one
 * matching the reader's level, so eight consecutive German B1 passages were all "the train is late".
 * A brief says *how* to write; a topic says *what* to write about, and novelty has to come from here.
 *
 * Deliberately plain: an everyday situation a learner might meet, not a literary prompt. The rubric and
 * the brief still decide register, length and vocabulary ceiling.
 */
import type { CefrLevel, TargetLang } from "../../lib/lang";

export const TOPICS: Record<TargetLang, Partial<Record<CefrLevel, string[]>>> = {
  de: {
    A2: [
      "Buying a ticket at the station and finding the right platform",
      "A neighbour asks you to water their plants while they are away",
      "The supermarket is out of the one thing you came for",
      "A first day at a new job and where everything is kept",
      "Rain, a broken umbrella, and a shop that sells only socks",
      "A parcel that went to the wrong building",
      "Sunday breakfast with relatives who arrive too early",
      "Learning to ride a bicycle again as an adult",
    ],
    B1: [
      "A delayed train and a stranger who explains what he does with the time",
      "Your landlord wants to raise the rent and the reason sounds rehearsed",
      "A colleague takes credit for work you did",
      "The swimming pool closes for renovation and the town argues about it",
      "A friend moves away and asks you to keep something of hers",
      "A course you signed up for is not what the description promised",
      "The bakery changes hands and the bread changes with it",
      "A lost phone, and the person who found it wants to meet",
    ],
    B2: [
      "What a move to a new city actually costs, beyond the rent",
      "A works council meeting about shifts nobody wants",
      "The village's only doctor retires and nobody replaces her",
      "Why a museum returned an object it had held for eighty years",
      "A language course that teaches grammar but not how to speak",
      "A parent's opinion of the school system, and the statistics they quote",
      "Working from home when the flat is too small for it",
      "A festival the town can no longer afford",
    ],
  },
  en: {
    A2: [
      "A dog that comes home cleaner than it left",
      "The bus is full and the driver has an idea",
      "A first day at a language school in a new country",
      "A parcel delivered to the wrong flat",
      "The café runs out of milk on the busiest morning",
      "A neighbour's cat adopts a different family",
      "Learning to cook one dish properly",
      "A weekend trip where the map is wrong",
    ],
    B1: [
      "A small town closes its main street to cars and what happens next",
      "A flatmate who never does the washing up, and the conversation about it",
      "The library extends its hours and the reason is not reading",
      "A job interview where the questions are about the questions",
      "A friend's wedding and the seat you are given",
      "A gym that charges for a year and closes in March",
      "The night bus, and who takes it",
      "A second-hand bicycle with a history",
    ],
    B2: [
      "Why a city's nightlife moved to one street, and who was pushed out",
      "The case for and against homework, from a parent who has read the studies",
      "A company's four-day week and the numbers after a year",
      "What a cancelled train reveals about how the network is run",
      "An old factory turned into flats, and the people who used to work in it",
      "Why the local newspaper closed and what replaced it",
      "A language you learned as a child and mostly forgot",
      "The ethics of a cheap flight",
    ],
  },
};

/**
 * A topic not already used at this language and level, or the least recently used one.
 *
 * The used set comes from the writer's own database, which holds every passage it has ever written and
 * every one it has pushed elsewhere — so a topic is not reused until the list has been walked once.
 */
export function pickTopic(
  targetLang: TargetLang,
  level: CefrLevel,
  used: string[],
): string {
  const topics = TOPICS[targetLang]?.[level] ?? TOPICS[targetLang]?.B1 ?? [];
  if (topics.length === 0) return "";
  const seen = new Map<string, number>();
  for (const topic of used) seen.set(topic, (seen.get(topic) ?? 0) + 1);
  const fresh = topics.filter((topic) => !seen.has(topic));
  if (fresh.length > 0) return fresh[0];
  // Everything has been used: take whichever was used least.
  return [...topics].sort((a, b) => (seen.get(a) ?? 0) - (seen.get(b) ?? 0))[0];
}
