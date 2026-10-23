# Rebuilding a track: the process, and the English plan

## What was done to the German track

The problem was not that the dictionary was large. It was that **one data structure was doing four jobs**,
so nothing could be replaced without replacing everything.

```
JOB            OLD                              NEW                        MEASURED
──────────────────────────────────────────────────────────────────────────────────────────
split text     own tokeniser (Intl.Segmenter)   SoMaJo via a sidecar       410 vs 412 spans on a
                                                                           real passage; 10:30 and
                                                                           Prof. stay whole
lemma          inflections table, 217k rows     Simplemma per token,       wache → wachen,
                                                stated (outranks lookup)   aufgewacht → aufwachen
clause join    separationOf + clause position    HanTa's PTKVZ tag          wache…auf → aufwachen
                                                                           finds…statt → stattfinden
                                                                           vor…liest → vorlesen
level          frequency-derived, 2.9% of rows   Goethe lists, curated      4,419 levels; agreement
               and 25–42% agreement             (ground truth)             with the old scale was
                                                                           25–42%, which is why
                                                                           this was the point
translation    derived glosses, 218k rows        wordbook (Goethe +         48 of 58 words glossed
                                                wordfeather), dictionary    from the book on a
                                                as fallback                 packed passage
gender         words.article (77k)               wordbook.article           1,385 from Goethe,
                                                                           normalised to der/die/das
```

**The method, in the order that made it safe:**

1. **Find who still reads the structure.** The read path had already been made package-based, so every
   dictionary caller left was a *write*. That is what made piece-by-piece replacement possible.
2. **Replace behind a flag, with a fallback that works.** Every new piece returns `null`/falls back on
   failure: no sidecar → built-in segmenter; no wordbook row → dictionary gloss. A missing sidecar once
   crashed the service, which is how that rule got written.
3. **Measure against the old answer before switching.** The first SoMaJo pack produced zero words because
   `classify` treats `isWordLike: undefined` as punctuation; the first wordbook merge glossed 12 of 127
   because it only merged into keys the dictionary already had. Both were found by comparing, not by
   reading the code.
4. **Record provenance per field.** `levelSource`, `translationSource` — a level means something different
   from a Goethe list than from a frequency table.

## The English track

**What is already shared, with no work:** the sidecar handles `en` and `de`. SoMaJo ships `en_PTB`, HanTa
ships `morphmodel_en.pgz`, Simplemma covers both. Verified on English text:

```
  She has been looking after the dog since it arrived.
  she(have) (be) looking(look) after the dog since it arrived(arrive)
  tags: PNP VHZ VBN VVG PRP AT0 NN1 CJS PNP VVD        ← CLAWS, not Tiger
```

**Where English differs, and what that costs:**

```
  phrasal verbs    German marks the particle (PTKVZ). English tags `up` as AVP but `after` as PRP,
                   which is indistinguishable from a preposition. So: join on AVP (`give up`),
                   leave PRP alone (`look after` stays two words — glosses still work per word).
  level data       IELTS lists are band-scored, not CEFR, and mostly © British Council.
                   CEFR-J (Tono Lab, TUFS) publishes A1–B2 English word lists with item difficulty.
  Chinese glosses  the German track was glossed in English; English needs zh. ECDICT is the analogue
                   of Beolingus: open, English→Chinese, millions of entries.
```

**The plan, mirroring the German one step for step:**

```
  1. wordbook gains a language dimension      targetLang in the key; two books, one table
  2. English book                             CEFR-J levels + ECDICT glosses, same builder shape
  3. English tagging check                    AVP joins verified; PRP deliberately not joined
  4. coverage measurement                     the lemmas the app packs, per track
  5. remove the legacy stack                  stop at LEGACY.md's conditions, in its order
```

**Done means** both tracks pack through SoMaJo + Simplemma + HanTa + wordbook, both books cover the packed
vocabulary, and deleting the tables in `LEGACY.md` leaves `npm run walk`, `npm run parity` and the test
suite green.
