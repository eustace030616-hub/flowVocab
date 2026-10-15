/**
 * Grouping translations for display.
 *
 * A headword can legitimately have several readings — "train" is a noun (火车, 列车) and a verb
 * (训练, 培训, 培育) — and a running-text token carries no part of speech, so the interface cannot
 * silently choose one. Listing every gloss individually is too noisy; listing one per part of
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
}

/**
 * The label to show for a group (declared before its first use, for clarity).
 *
 * One rule for every case, so the preview has a single template: prefer the headword's part of
 * speech, fall back to the translation's own when the headword has none. Null when neither is
 * known — an empty label column keeps the text aligned without inventing a dash that reads like
 * a part of speech of its own.
 */
export function meaningLabel(group: MeaningGroup): string | null {
  return group.pos ?? group.termPos ?? null;
}

export interface MeaningGroup {
  pos: string | null;
  texts: string[];
  /** Part of speech of the terms in this group, when every one of them agrees. */
  termPos: string | null;
}

/**
 * Group by the headword's part of speech, keeping the input order (which the caller has already
 * sorted best-first), de-duplicating texts, and capping each group.
 */
export function groupMeanings(meanings: Meaning[] | undefined, maxPerGroup = 3): MeaningGroup[] {
  if (!meanings?.length) return [];

  const groups = new Map<string, MeaningGroup>();

  for (const meaning of meanings) {
    const key = meaning.pos ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { pos: meaning.pos, texts: [], termPos: meaning.termPos };
      groups.set(key, group);
    }
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

  const deduped = ordered.map((group) =>
    meaningLabel(group)
      ? group
      : { ...group, texts: group.texts.filter((text) => !labelled.has(text)) },
  );

  return deduped.filter((group) => group.texts.length > 0);
}

