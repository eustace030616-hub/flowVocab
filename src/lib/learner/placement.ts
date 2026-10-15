/**
 * Placement test: a yes/no lexical test with pseudowords, for the cold start the old model had none
 * of.
 *
 * The protocol is Brysbaert et al. (2016): **67 real words + 33 pseudowords**, with the learner
 * warned against over-claiming. The real words measure how much they know; the pseudowords measure
 * how readily they claim to know things they cannot, and that rate is subtracted rather than
 * assumed.
 *
 * Two deliberate departures from a naive reading of that paper:
 *
 *   - **The estimate is a fitted ability, not a word count.** The paper reports `hits − falseAlarms`
 *     as a vocabulary-size score. That difference is confounded by response style — a yes-sayer and
 *     a careful reader with the same knowledge score differently — which Huibregtse & Admiraal
 *     (2002) address. So the responses are fitted directly: each real word becomes an observation on
 *     the same difficulty axis as every other item in the app, with a guessing floor equal to the
 *     learner's own false-alarm rate. `hits − falseAlarms` is still reported, because it is the
 *     number the protocol is known by and it is useful to see.
 *
 *   - **The pseudowords are generated here, not by Wuggy.** Wuggy matches subsyllabic structure,
 *     which is better; it is also a Python package that is not a dependency of this project. The
 *     requirement that actually matters is that a pseudoword is plausible *and not a word*, and
 *     non-membership can be checked rigorously against the same 281k-lemma lexicon the reader uses —
 *     a check the paper's own procedure does not have. The generator is documented as a substitute
 *     rather than passed off as Wuggy.
 *
 * Pure: generation is seeded and scoring takes plain responses, so both are testable.
 */

import { ABILITY_SCALE, fitAbility, probabilityYes, type AbilityEstimate, type Observation } from "./ability";
import { levelFromDifficulty } from "../difficulty";
import type { CefrLevel, TargetLang } from "../lang";

/** The protocol's proportions, kept exact so the reported numbers mean what the paper means. */
export const REAL_WORDS = 67;
export const PSEUDOWORDS = 33;

export interface PlacementItem {
  /** Opaque id sent to the client; carries no signal about which items are fake. */
  id: string;
  text: string;
  /** Server-side only. Never serialised to the client. */
  isPseudoword: boolean;
  /** Difficulty of a real word; pseudowords carry none. */
  difficulty?: number;
}

export interface PlacementResponse {
  id: string;
  yes: boolean;
}

export interface PlacementScore {
  hits: number;
  falseAlarms: number;
  /** hits − falseAlarms, the protocol's headline number. */
  corrected: number;
  /** Proportion of pseudowords claimed, [0, 1]. */
  falseAlarmRate: number;
  /**
   * d′ from signal detection theory, with the log-linear correction for rates of 0 or 1.
   *
   * Reported alongside the fitted ability because it separates sensitivity from response bias, which
   * is the confound the corrected difference score has.
   */
  dPrime: number;
  estimate: AbilityEstimate;
}

/** Deterministic PRNG, so a seed reproduces a test exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable numeric seed from a string, so the same learner and language give the same test. */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Mutations that produce a pronounceable non-word.
 *
 * Orthographic rather than phonemic: German and English spelling is regular enough that a plausible
 * letter sequence reads as a plausible word. Each rule preserves the word's rough shape and length,
 * which is what stops a learner spotting the fakes by their look alone.
 */
function mutate(word: string, random: () => number): string | null {
  const lower = word.toLowerCase();
  if (lower.length < 4) return null;

  const vowels = "aeiouäöü";
  const rule = Math.floor(random() * 3);

  if (rule === 0) {
    // Swap two adjacent letters away from the edges.
    const i = 1 + Math.floor(random() * (lower.length - 3));
    return lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
  }

  if (rule === 1) {
    // Replace one vowel with another, keeping the syllable count.
    const positions = [...lower].map((c, i) => (vowels.includes(c) ? i : -1)).filter((i) => i >= 0);
    if (positions.length === 0) return null;
    const at = positions[Math.floor(random() * positions.length)];
    const replacement = vowels[Math.floor(random() * vowels.length)];
    if (replacement === lower[at]) return null;
    return lower.slice(0, at) + replacement + lower.slice(at + 1);
  }

  // Duplicate an interior consonant — a shape that occurs in real words of both languages.
  const at = 1 + Math.floor(random() * (lower.length - 2));
  return lower.slice(0, at) + lower[at] + lower.slice(at);
}

export interface PseudowordOptions {
  count: number;
  seed: number;
  /** Words to avoid colliding with: the full lexicon, not just the sampled items. */
  isRealWord: (candidate: string) => boolean;
  /** Real words to derive from, so the fakes match the register of the test. */
  donors: string[];
}

/**
 * Generate pseudowords that are plausible and provably not words.
 *
 * Rejection sampling against `isRealWord` is the part that matters: a "pseudoword" that happens to
 * be a real word in the target language tests the opposite of what it is for — a learner who knows
 * it says yes and is scored as over-claiming.
 */
export function generatePseudowords(options: PseudowordOptions): string[] {
  const { count, seed, isRealWord, donors } = options;
  const random = mulberry32(seed);
  const out: string[] = [];
  const seen = new Set<string>();

  // Bounded attempts: a lexicon this large will reject many candidates, and looping forever on a
  // pathological donor set would hang the request.
  const maxAttempts = count * 400;
  for (let attempt = 0; attempt < maxAttempts && out.length < count; attempt += 1) {
    const donor = donors[Math.floor(random() * donors.length)];
    if (!donor) break;
    const candidate = mutate(donor, random);
    if (!candidate || candidate.length < 4) continue;
    if (seen.has(candidate) || isRealWord(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }

  return out;
}

/** Log-linear correction, so a rate of exactly 0 or 1 does not send d′ to infinity. */
function zFromRate(successes: number, total: number): number {
  const rate = (successes + 0.5) / (total + 1);
  return inverseNormalCdf(rate);
}

/** Acklam's rational approximation of the inverse normal CDF; accurate to ~1e-9, no dependency. */
function inverseNormalCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;

  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Score a completed test.
 *
 * Real-word responses become observations with the learner's own false-alarm rate as the guessing
 * floor, so an over-claimer is corrected by their own behaviour rather than by a constant.
 */
export function scorePlacement(
  items: PlacementItem[],
  responses: PlacementResponse[],
): PlacementScore {
  const byId = new Map(responses.map((r) => [r.id, r.yes]));

  // Only answered items count, in both halves of the test.
  //
  // This is what makes "exit whenever you like" honest. Scoring the full item set treats every
  // unanswered word as a "don't know", which depresses the hit rate — and, worse, silently changes
  // the false-alarm rate depending on how far the learner got. Rates over the answered subset are
  // unbiased; a shorter test is simply a noisier one, and the standard error says so.
  const answered = items.filter((item) => byId.has(item.id));
  const realItems = answered.filter((item) => !item.isPseudoword);
  const pseudoItems = answered.filter((item) => item.isPseudoword);

  const observations: Observation[] = [];
  let hits = 0;
  for (const item of realItems) {
    const yes = byId.get(item.id) === true;
    if (yes) hits += 1;
    if (item.difficulty === undefined) continue;
    observations.push({ difficulty: item.difficulty, known: yes, weight: 1 });
  }

  const falseAlarms = pseudoItems.filter((item) => byId.get(item.id) === true).length;
  const falseAlarmRate = pseudoItems.length ? falseAlarms / pseudoItems.length : 0;

  const hitRate = realItems.length ? hits / realItems.length : 0;
  const dPrime = zFromRate(hits, realItems.length) - zFromRate(falseAlarms, pseudoItems.length || 1);

  const estimate = fitAbility(observations, { guessing: falseAlarmRate });

  return {
    hits,
    falseAlarms,
    corrected: hits - falseAlarms,
    falseAlarmRate,
    dPrime,
    estimate,
  };
}

/**
 * The placement's own observations, for folding into the general ability estimate.
 *
 * Each real word's answer becomes an observation carrying the test's false-alarm rate as its
 * guessing floor, so an over-claimer is corrected by their own behaviour rather than by a constant.
 */
export function placementObservations(
  items: PlacementItem[],
  responses: PlacementResponse[],
): Observation[] {
  const byId = new Map(responses.map((r) => [r.id, r.yes]));
  const answeredPseudo = items.filter((i) => i.isPseudoword && byId.has(i.id));
  const falseAlarms = answeredPseudo.filter((i) => byId.get(i.id) === true).length;
  const floor = answeredPseudo.length ? falseAlarms / answeredPseudo.length : 0;

  return items
    .filter((item) => !item.isPseudoword && item.difficulty !== undefined && byId.has(item.id))
    .map((item) => ({
      difficulty: item.difficulty as number,
      known: byId.get(item.id) === true,
      weight: 1,
      guessing: floor,
    }));
}

/** The levels a score implies, for telling the learner where they landed. */
export function placementLevels(score: PlacementScore): {
  level: CefrLevel | null;
  levelLow: CefrLevel;
  levelHigh: CefrLevel;
} {
  const low = levelFromDifficulty(Math.max(0, score.estimate.theta - 1.96 * score.estimate.se));
  const high = levelFromDifficulty(Math.min(1, score.estimate.theta + 1.96 * score.estimate.se));
  return { level: score.estimate.level, levelLow: low ?? "A1", levelHigh: high ?? "C2" };
}

export { ABILITY_SCALE, probabilityYes };
