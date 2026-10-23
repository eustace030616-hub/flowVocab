# What is legacy, and what has to be true before it goes

Every entry below is marked `LEGACY(...)` in the source, so `grep -rn "LEGACY(" src` lists them.

```
COMPONENT                       WHY IT EXISTS TODAY                    REMOVE WHEN
──────────────────────────────────────────────────────────────────────────────────────────
store/dictionary.ts             the 839k-row vocabulary: words,         both word books cover the
  (words, inflections,          inflections, glosses, compounds,        vocabulary the app packs,
   glosses, compounds,          separations. 198 MB of 249.             and generation no longer
   separations)                                                         measures against it
learner/lexicon.ts              resolves inflected forms through         Simplemma + the word book's
  (tokenizeAgainst's            `inflections`, and composes compounds    `forms` supply lemmas for
   lexicon passes)              from `words`                             tagged text
tokenize/index.ts               attachSeparableParticles,                the sidecar's PTKVZ join
  (particle rules)              mergedInfinitive, separationOf — the     covers German; AVP covers
                                clause-level join for untagged text      English; imports keep tags
learner/glosses.ts              per-lemma translations from the          the word books carry
                                derived gloss table                      translations for both tracks
scripts/import/*                fill the dictionary from Beolingus,      the word books are the source
                                kaikki, Wiktionary                       of record
```

**Not legacy:** `store/content.ts` (passages, pool), `store/learner.ts` (marks, events, states),
`store/calibration.ts`, `store/stars.ts`, `auth`, `pack`, `wordbook`, and the whole reader API. Those are
the product, not the substrate.

The order of removal matters: `inflections` and `separations` go first (the sidecar replaces both),
`glosses` second (the word books replace it for both tracks), `words` last — its `difficulty` column is the
only curated number the IRT model has, and it stays until the word books prove themselves on real reading.
