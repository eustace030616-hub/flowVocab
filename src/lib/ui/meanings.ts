/**
 * Grouping translations for display.
 *
 * A headword can legitimately have several readings — "train" is a noun (火车, 列车) and a verb
 * (训练, 培训, 培育) — and a running-text token carries no part of speech, so the interface cannot
 * silently choose one. Listing every gloss individually is too noisy; listing one line per part of
 * speech is the shape a learner can actually read:
 *
 *     n   火车, 列车
 *     v   训练, 培训, 培育
 *
 * Pure, so the ordering and the pruning are tested rather than eyeballed.
 */

export interface Meaning {
  pos: string | null;
  termPos: string | null;
  text: string;
  source: string;
  /** Cross-source preference; lower is better. */
  rank?: number;
}

export interface MeaningGroup {
  pos: string | null;
  texts: string[];
  /** Part of speech of the terms in this group, when every one of them agrees. */
  termPos: string | null;
}

export interface GroupOptions {
  /** Most translations to show for one reading. */
  maxPerGroup?: number;
  /**
   * Most readings to show at all.
   *
   * A word with three parts of speech and three glosses each otherwise renders nine lines, which
   * is a concordance rather than a hint. Two readings of two glosses is what someone can take in
   * while reading.
   */
  maxGroups?: number;
}

/**
 * The label to show for a group.
 *
 * One rule for every case, so the preview has a single template: prefer the headword's part of
 * speech, fall back to the translation's own when the headword has none. Null when neither is
 * known — an empty label column keeps the text aligned without inventing a dash that reads like a
 * part of speech of its own.
 */
export function meaningLabel(group: MeaningGroup): string | null {
  return group.pos ?? group.termPos ?? null;
}

interface BuildingGroup extends MeaningGroup {
  /** Best (lowest) rank among this group's meanings; orders the groups. */
  bestRank: number;
}

/**
 * Group by the headword's part of speech, then prune and order.
 *
 * Order is decided by the best-ranked gloss in each group, so the source that leads for that
 * reading also leads in the list. Pruning is deliberate: several sources each contribute glosses,
 * and without a cap the preview becomes a list of everything anyone has ever said about the word.
 */
export function groupMeanings(
  meanings: Meaning[] | undefined,
  options: GroupOptions = {},
): MeaningGroup[] {
  if (!meanings?.length) return [];

  const { maxPerGroup = 2, maxGroups = 2 } = options;

  const groups = new Map<string, BuildingGroup>();
  for (const meaning of meanings) {
    const key = meaning.pos ?? "";
    let group = groups.get(key);
    if (!group) {
      group = {
        pos: meaning.pos,
        texts: [],
        termPos: meaning.termPos,
        bestRank: meaning.rank ?? Number.MAX_SAFE_INTEGER,
      };
      groups.set(key, group);
    }
    group.bestRank = Math.min(group.bestRank, meaning.rank ?? Number.MAX_SAFE_INTEGER);
    if (group.texts.length >= maxPerGroup) continue;
    if (!group.texts.includes(meaning.text)) group.texts.push(meaning.text);
    // A label only survives if every term in the group carries it; otherwise it would be a claim
    // about some of the readings presented as a claim about all of them.
    if (group.termPos !== meaning.termPos) group.termPos = null;
  }

  const ordered = [...groups.values()];

  // A translation is shown once. The same text can arrive under an unlabelled group (a curated
  // gloss with no part of speech) and a labelled one (the dictionary entry), which displayed
  // "aufstehen" twice — once bare and once as "v to get up". The labelled group wins the text,
  // because it carries strictly more information.
  const labelled = new Set<string>();
  for (const group of ordered) {
    if (!meaningLabel(group)) continue;
    for (const text of group.texts) labelled.add(text);
  }

  return ordered
    .map((group) =>
      meaningLabel(group)
        ? group
        : { ...group, texts: group.texts.filter((text) => !labelled.has(text)) },
    )
    .filter((group) => group.texts.length > 0)
    .sort((a, b) => a.bestRank - b.bestRank)
    .slice(0, maxGroups)
    .map(({ pos, texts, termPos }) => ({ pos, texts, termPos }));
}
