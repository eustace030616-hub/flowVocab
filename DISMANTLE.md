# Dismantling the dictionary

Measured on the Pi: **198 MB of a 249 MB database** is the dictionary. The first question worth answering
is not "how do we shrink it" but "who still reads it", because that decides how safe each step is.

## The read path no longer needs it

```
  GET /api/paragraphs/:id      spans from the package, glosses from the package,
                               difficulty from the package → pKnown, band, coverage
                               wordsByKeys only when a passage has no package   ← the one fallback
```

Every other caller of the tokeniser is a write:

```
  src/lib/content/pack.ts                 packing a passage
  src/scripts/generate/generate.ts        acceptance, rubric, coverage
  src/scripts/import/recompute-difficulty.ts   an offline tool
  src/scripts/qa/paragraphs.ts            an offline check
```

So the dictionary is a **write-time working set**. That is the licence to dismantle it piece by piece:
readers cannot notice a mistake until the next passage is written, and `npm run walk` / `npm run parity`
both exercise the write path.

## What it weighs, and what each part is for

```
  part                     size            job                        replaceable by
  glosses + index          41 MB           popover translations       the model, in the generation
                                                                      payload (the package already
                                                                      stores glosses per lemma)
  inflections + index      42 MB           inflected → lemma          the model, which already returns
                                                                      the lemma of every token
  words + indexes          89 MB           lemma, POS, difficulty,    keep the difficulty column
                                           level, frequency           (~15 MB slim); the rest is
                                                                      metadata the package duplicates
  compounds + separations  14 MB           German compound handling   the model, as compound parts
  ──────────────────────── 198 MB
```

## Order, safest first

```
  1. glosses        41 MB    Generation writes `gloss` per lemma into the package; the dictionary's
                             gloss is the fallback for unpacked passages. A missing gloss degrades to
                             "no translation yet", never to an error.
                             Verify: pack one passage, read it, compare the popover.

  2. inflections    42 MB    The model returns each token's lemma; `tokenizeAgainst`'s lookup becomes a
                             fallback. Lemma accuracy is the whole risk, and it is measurable: tokenise
                             the same passage both ways and diff the lemmaKeys.
                             Verify: `npm run qa` over the stored passages, disagreement reported.

  3. compounds      14 MB    Compound parts come from the model; decomposition is dropped for passages
                             it wrote, kept for imported text.
                             Verify: a compound-heavy passage still glosses each part.

  4. keep           15 MB    `words(lemmaKey, difficulty, level)` is the grading core: the IRT needs a
                             number per word, and `word_levels` grows from model output with the
                             difficulty votes as the correction signal. Nothing else survives.
```

## SoMaJo

Installed on the Pi (2.5.0, models `de_CMC` / `en_PTB`) with a sidecar at
`tools/tokenize/server.py` and an adapter at `src/lib/tokenize/somajo.ts`. It changes **segmentation
only** — the reader gets better sentence boundaries, abbreviations and quotes — and it does not touch
lemmatisation, which is where 42 MB of the weight actually is.

It is deliberately **not wired in yet.** Segmentation happens inside `tokenize()`, which builds spans and
is the most delicate module in the repository; threading a segmenter through it is a change that should
be made with the tokeniser tests in front of it, not after a week of edits. The seam is:

```
  tokenize(text, lang, options)                  → spans          (builds from Intl.Segmenter)
  spansFromTokens(tokens, text, lang, options)   → spans          (the part to extract)
  tokenize = spansFromTokens(segment(text), …)                    (then SoMaJo drops in here)
```
