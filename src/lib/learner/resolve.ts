/**
 * Resolving which vocabulary entry a learner's mark belongs to.
 *
 * Identity is `(targetLang, lemma, pos)`, so a caller that does not know the part of speech
 * cannot simply upsert on `(lemmaKey, pos: "")` — that creates a *second* row for a word already
 * in the vocabulary, which fragments the entry, drops its level and gloss, and splits the
 * learner's history across two documents.
 *
 * This was a real bug: marking "aufstehen" produced a duplicate with `lemma: "steht"` and
 * `pos: ""` alongside the seeded `pos: "verb"` entry.
 *
 * Pure and separate from the database so the preference order is testable.
 */

export interface HasPos {
  pos?: string;
}

/**
 * Choose an existing entry for a mark, or null to create one.
 *
 * Preference: the exact part of speech when the caller supplied one, else any entry for this
 * lemma that already carries one, else whatever exists.
 */
export function pickExistingWord<T extends HasPos>(
  candidates: T[],
  pos: string,
): T | null {
  if (pos) {
    const exact = candidates.find((candidate) => candidate.pos === pos);
    if (exact) return exact;
  }
  const classified = candidates.find((candidate) => candidate.pos);
  return classified ?? candidates[0] ?? null;
}
