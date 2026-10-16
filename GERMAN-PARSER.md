# The German parser: what is compiled, and what is still hard

A place to start on the linguistic layer. Written after the runtime rules produced their fourth
reader-visible bug, so it records what was tried and what it cost, not just what to install.

## The shape of the thing

The runtime never calls a parser. German morphology is **compiled offline into tables**, and the
runtime does a keyed lookup — the one job it does well. That keeps the reader deterministic,
testable, offline and free, and it makes every remaining mistake a *data* question rather than a
heuristic one.

```
offline (compile)                          runtime (unchanged, no Python)
  Wiktionary form_of      ──► Inflection   form → citation form      "liest" → "lesen"
  Wiktionary auf.stehen   ──► Separation   particle + verb → merged  ("auf","stehen") → "aufstehen"
  lexicon-valid splits    ──► Compound     form → parts              "wortschatzaufbau" → …
```

```bash
npm run import:kaikki        # 217k form → lemma mappings (also the German glosses)
npm run compile:german       # 3,195 separable verbs, 110,676 lexicon-valid compounds
npm run qa:paragraphs        # headless check of what the reader actually receives
```

`src/scripts/morphology/compile-german.ts` builds the last two. Both are **authoritative when
present**: if `Separation` has no pair for a particle and verb, the tokenizer does not attach them,
however close they sit on the page. When the tables are empty — a fresh clone — the old heuristics
still run, so the app works but less well.

## Why tables: the four bugs that forced it

| rule the runtime used | what a reader saw | what fixed it |
|---|---|---|
| suffix lemmatisation | `liest` → the noun **Liest**; `kurzen` → **Kurze** | Wiktionary `form_of` data |
| proximity particles | `wächst eine` → **einwachsen** | a clause-final guard (a patch) |
| proximity particles | `setzte … gegenüber` → **gegenübersetzen** | the compiled separation table |
| lexicon splitting | `kurzen Text` → **Kurztext** | the compiled compound table |

Every fix moved a rule into a table. That is the whole argument for this design.

The `gegenübersetzen` case is the instructive one: it is a *real* verb, so existence checks passed,
and it was *unglossed*, so the learner got a word the app could not explain. The compiler therefore
keeps a separation only when the merged verb is both in the vocabulary **and** translatable — one
condition that would have caught it.

## What is still hard, in the order I would attack it

### 1. Particles are lexicon-driven, not syntactic

The table says `("auf","stehen")` is a valid pair. It cannot say whether a particular sentence uses
them together. `Ich stehe auf dem Bahnsteig` has `auf` as a preposition, and the clause-final guard
is what stops it merging — a guard, not a parse.

**A dependency parse answers this exactly.** spaCy labels a separated prefix `svp` and attaches it to
its verb; Stanza's UD models use `compound:prt`. That is the single highest-value upgrade available,
and it emits the same `particle` rows this compiler already writes.

### 2. Compound splits have no frequency signal

`lexiconSplit` accepts any split where both halves are known words, preferring the longest head.
That cannot choose between `Wachs|tube` and `Wach|stube`. A statistical splitter
([CharSplit](https://github.com/dtuggener/CharSplit) is the usual one; a
[2025 comparison](https://acl-bg.org/proceedings/2025/RANLPStud%202025/2025.ranlpstud-1.pdf) covers
the split modes) ranks candidates by letter n-grams or corpus frequency. Same output shape, better
ordering — and the parts are already validated against the lexicon, which is the part pure
statistical splitters get wrong.

### 3. Adjacent problems nobody has solved here

- **Multi-word units**: `zur Welt kommen`, `in der Lage sein`. Phrase-level, currently not modelled at
  all — each word is explained alone, and the idiom is lost.
- **Named entities**: `Uefa` resolves to an entry with no gloss. Arguably it should not be counted as
  untranslated vocabulary at all.
- **Vocabulary breadth (English)**: `favorable` is absent from the CEFR list entirely, `happen` is
  present but CC-CEDICT does not gloss it. This is data acquisition, not parsing.
- **Stale level claims**: improving the morphology raised a paragraph's coverage from 98.0% to 99.1%,
  past the "too easy" bound for its claimed B2. A stored paragraph whose measurement no longer
  matches its label needs re-deriving — `qa:paragraphs` reports it, nothing acts on it yet.

## Tools, and what I actually verified here

| tool | gives | status from this machine |
|---|---|---|
| **spaCy** `de_core_news_md` | tokens, POS, **lemma, dependency parse** | **failed to install** — no wheels for Python 3.9 here, source build errored. Try a newer Python or conda |
| **Stanza** | same, UD models | not tried; pulls in PyTorch (large) |
| **HanoverTagger** | German lemma + morphology, purpose-built | not tried; the lightest option worth evaluating next |
| **IWNLP** / GermaLemma | lemma lookup from Wiktionary | not tried; Java / light Python |
| **CharSplit** | compound splitting | not tried |
| [**TreeTagger**](https://www.cis.lmu.de/~schmid/tools/TreeTagger/) | classic POS + lemma | not tried; binary |
| **Google Cloud NL [`analyzeSyntax`](https://docs.cloud.google.com/natural-language/docs/morphology)** | lemmas, POS, **dependency tree**, German supported | commercial, per request, online |

`src/scripts/morphology/compile_german.py` is written and working except for its model: it drives
spaCy, emits the three row kinds, and is the file to point at a different analyser. Its docstring
carries the same reasoning as this document.

## How to plug in a real parser

Write to the same three row kinds and nothing downstream changes:

```jsonl
{"kind":"lemma","form":"liest","lemma":"lesen","pos":"VERB"}
{"kind":"particle","particle":"auf","verb":"stehen","source":"parse"}
{"kind":"compound","form":"wortschatzaufbau","parts":["wortschatz","aufbau"]}
```

Then import them into `Inflection`, `Separation` and `Compound`, and the runtime picks them up with
no code change — that seam already exists and is exercised by two importers. The compiler keeps the
same guardrails whatever produces the rows: a base must be in the vocabulary, a merged verb must also
be translatable, and every compound part must be a real word.
