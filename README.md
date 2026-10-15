# Flowwing

A stress-free vocabulary-learning app. Read paragraphs slightly above your level, click unknown
words for instant translations, and let the app re-target content to your ability.

Two learner tracks, each a `(targetLang, glossLang, uiLocale)` triple:

| Track | Learner | Target | Glossed in |
|---|---|---|---|
| `zh-en` | a Chinese speaker | English | Chinese |
| `en-de` | an English speaker | German | English |

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router) + Tailwind CSS |
| API | Hono (embedded in Next.js via `hono/vercel`) |
| Database | MongoDB 8 + Mongoose |
| Container | Docker Compose |

## Quick start

```bash
npm install
npm run fetch:data                 # open datasets (~300 KB); --full adds the large corpora
docker compose up --build -d       # starts Mongo and the app
npm run import:licences            # LICENSES/ manifest + provenance collection
npm run import:english             # 9,779 (lemma, pos) rows from CEFR-J + Octanove
npm run import:german              # DWDS frequency + estimated CEFR bands
npm run seed                       # demo paragraphs and vocabulary, both tracks
```

Open http://localhost:3000 and switch tracks in the header.

> **Running the scripts outside Docker.** They default to `mongodb://db:27017/myapp`. Point
> `MONGODB_URI` at your instance, e.g. `MONGODB_URI=mongodb://localhost:27017/flowwing npm run seed`.

## Project structure

```
app/
├── page.tsx                       paragraph viewer; renders server-provided spans
├── layout.tsx                     root HTML shell
└── api/[[...route]]/route.ts      all API endpoints (Hono)

src/
├── lang.ts                        tracks, target/gloss/ui language identity
├── lib/
│   ├── db.ts                      MongoDB connection
│   ├── tokenize/
│   │   ├── index.ts               tokenize() → spans; separable verbs, compounds, coverage
│   │   ├── normalize.ts           NFC storage form vs the lossy folded search key
│   │   └── rules.ts               lemma candidate generation (en, de)
│   ├── learner/
│   │   ├── state.ts               derive state from the append-only event log
│   │   ├── lexicon.ts             server-side lemma lookup against the database
│   │   ├── glosses.ts             read glosses, prefer the best-ranked source
│   │   ├── resolve.ts             attach a mark to an existing word, never fork it
│   │   └── user.ts                learner identity (cookie; not auth)
│   ├── difficulty.ts              frequency → continuous difficulty, calibrated on CEFR
│   └── licence/
│       ├── datasets.ts            every source + its licence, as code
│       └── index.ts               LICENSES/ manifest generation
├── models/
│   ├── Paragraph.ts               content, language, difficulty, coverage
│   ├── Word.ts                    shared reference data: (targetLang, lemma, pos), level, frequency
│   ├── Gloss.ts                   translations, ONE DOCUMENT PER SOURCE (licence seam)
│   ├── Inflection.ts              stated form → citation form (liest → lesen)
│   ├── WordState.ts               PER LEARNER: status, timesMet, unfamiliarity, …
│   ├── Mark.ts                    one learner's mark on one character span
│   ├── Event.ts                   append-only log: the source of truth
│   ├── User.ts                    learner + current track
│   └── Provenance.ts              per-dataset licence records
└── scripts/
    ├── seed.ts, seed-data.ts      demo content for both tracks
    └── import/                    fetch-data.sh · import-english · import-german
                                   import-frequency · import-german-rank · import-ding
                                   recompute-difficulty · write-licences · ding.ts
```

## Data model

```
Word (shared reference)          WordState (per learner)          Paragraph
 targetLang                       userId                           targetLang
 lemma, pos                       targetLang, lemmaKey             title, content
 glosses[], level, frequency      wordId ──▶ Word                  difficulty, level
 article, plural                  status, timesMet,
 cognateWithEn, falseFriend       unfamiliarity, lookupCount,
        ▲                         exposureCount
        │                                 ▲
        └────────── Mark ─────────────────┤      Event (append-only)
                    (userId, paragraphId, │       userId, targetLang, type
                     charStart, charEnd)  └────── derives ──▶ WordState
```

Three things changed from the original model, and each was a blocker for the second language:

1. **A word's identity is `(targetLang, lemma, pos)`**, not its spelling. The old `word` field was
   globally unique, so German *Gift* and English *gift* would have merged into one record.
2. **An occurrence is a character span**, not an array index from `content.split(" ")`. Spaces do
   not delimit words in German compounds or separable verbs, and not at all in Chinese.
3. **Learner state is derived from an append-only event log, and is per learner.** `unfamiliarity`
   used to be the only copy of the history, and un-clicking decremented it destructively. It also
   lived on `Word` — shared reference data — so two learners overwrote each other. It now lives in
   `WordState`, keyed by `(userId, targetLang, lemmaKey)`.

`WordState` is a *cache*: recompute it from events at any time. `learning` is now reachable (met
3+ times, still unfamiliar) instead of being a dead enum value.

A mark resolves to an existing vocabulary entry rather than upserting on `(lemma, pos)` blindly —
otherwise a caller that does not send a part of speech creates a second row for a word already in
the vocabulary, splitting the learner's history across two documents (see `src/lib/learner/resolve.ts`).

## Glosses

Translations are **not** stored on `Word`. They live in `Gloss`, one document per translation per
source, because almost every usable dictionary is share-alike or copyleft and the rule for such
data is that it stays separable — merging licensed gloss text into a collection that also holds
proprietary content makes the whole collection an adaptation carrying the same licence. A separate
collection per source also lets one source be attributed, re-imported, or purged as a unit.

`rank` is a **cross-source** preference order: curated content claims 0 and imported dictionaries
start at 1, so a hand-written gloss outranks a dump. Ties break deterministically on source and text.

Gloss language follows the **content**, not the learner's stored track — English is glossed in
Chinese, German in English. Reading it off the track instead meant a request for German paragraphs
while the track was still `zh-en` looked for Chinese glosses and silently found none.

| Track | Gloss source | Coverage |
|---|---|---|---|
| `en-de` | ding / Beolingus, **GPL-3+** (copyleft) — primary; kaikki/Wiktionary, CC BY-SA 4.0 — gaps | 96,751 German headwords; 95–98% of the frequent bands, 17% of the rare tail |
| `zh-en` | CC-CEDICT, CC BY-SA 4.0 | 6,793 of 8,657 English headwords (79%) |

### Ranking a gloss is not free

CC-CEDICT is a *bilingual dictionary*, so inverting it asks "which Chinese word is the translation
of this English word", and both obvious answers are wrong:

```
frequency only      beautiful → 那 ("that", Zipf 6.0)     poison → 药 ("medicine")
specificity only    dog → 犬                             beautiful → 姹
```

Frequency picks function words; specificity picks obscure ones — translating exactly one English
word is also what makes a form rare. The score combines them, with a small guard list for deictic
words, and the weight was chosen by measuring a sample at three settings:

```
score = zipf − 0.8·ln(genericness) − (function word ? 3 : 0)
```

It is a heuristic, not a sense disambiguator. Ambiguous verbs remain the weak spot (`run` → 运行
rather than 跑), which is why up to three candidates are stored per reading.

### Inflection is data, not a guess

Suffix rules cannot lemmatise German reliably, and the failure was visible: `liest` (a form of
`lesen`) matched an unrelated noun entry, *Liest*, so the preview showed a noun's headword with a
verb form's description as its meaning. `kurzen` fared no better — the rules produced `kurze`, the
noun *Kurze*, while the word is an inflection of the adjective `kurz`.

Wiktionary **states** the base (`form_of`, 72% of its German entries), so that is stored as data in
`Inflection` — 226,717 mappings — and the tokenizer prefers a stated form over anything the rules
propose. A mapping is only honoured when its base is a real dictionary entry, so a word can never
resolve to something the glossary cannot gloss.

    liest    → lesen    n reading / v to read
    kurzen   → kurz     adj brief, short / adv briefly
    braucht  → brauchen v to need, to be in need of, to require

At most **two readings of two translations** are shown, ordered by the best-ranked gloss in each
group. Several sources each contribute glosses, and an uncapped list rendered nine lines for
`verstehen` — a concordance rather than a hint.

Separable-particle attachment requires the host to be a **verb**, which the lexicon supplies. The
morphology alone is not enough: "kurz" is a genuine separable prefix (*kurzarbeiten*), and once
`kurzen` resolved to `kurz` the parser fused it with the next word into the real noun *Kurztext*.

### Two German sources, one ranked behind the other

ding is human-curated and primary, but its headword inventory is thin on verbs — it has no entry for
`brauchen` at all, though the word appears in 104 of its example lists. Its glosses rank 1–3;
kaikki/Wiktionary fills the gaps at rank 5+. That took German coverage from 69,489 to 96,751
headwords, and in the frequent bands from 93% to **95–98%**.

The kaikki layer filters hard, because 45% of its German entries are inflected forms glossed
"inflection of …". Importing those would teach `braucht` as a *meaning* rather than a form.

### Part of speech is part of a meaning's identity

`train` is two vocabulary entries — `train/noun` (A1) and `train/verb` (A2) — and glosses are keyed
by `(lemma, pos)`, not by the lemma alone. A single flat list gave the *verb* reading 火车 (railway
train), because the noun sense is more frequent overall.

CC-CEDICT has no part-of-speech tags, but it marks infinitives, and normalising a gloss
(`to train` → `train`) was discarding exactly that. Counting the marker before discarding it, plus
the parts of speech of any gloss that is itself a headword we hold, gives a **derived** part of
speech per candidate — used both to rank (`train/verb` → 训练) and to label what is shown.

Where a token in running text has no part of speech — nothing knows `well-trained` is a verb — the
readings are **not** picked silently. They are grouped and shown labelled:

```
n   火车, 列车
v   训练, 培训, 培育
```

`termPos` coverage: 17,854 of 19,855 English→Chinese rows (90%). A label is emitted only when the
evidence is not a tie, and a group label is dropped if its readings disagree — an unlabelled gloss
is honest, a wrong label is not.

## Difficulty and levels

Item difficulty is continuous in `[0,1]`; CEFR is a label on top of it.

Difficulty is derived from **corpus frequency**, and the CEFR lists *calibrate* that mapping
rather than being the scale. For each level the median wordfreq Zipf is measured, and a monotone
piecewise-linear curve is fitted through those points. Every word then gets a continuous score,
including words no list covers.

| Track | Calibrated on | Measured anchors (Zipf) |
|---|---|---|
| English | CEFR-J v1.5 + Octanove C1/C2, re-merged on `(lemma, pos)` — 9,715 rows | A1 5.02 · A2 4.57 · B1 4.19 · B2 3.77 · C1 3.29 · C2 2.88 |
| German | **Goethe A1–B1, offline only** — 3,323 words | A1 5.02 · A2 4.71 · B1 4.44 |

The two languages agree on A1 (Zipf 5.02) while being fitted entirely independently, which is a
useful cross-check.

Three honest limitations, all deliberate:

- **German has no B2/C1/C2 anchors**, so 247,362 words rarer than the B1 anchor get a difficulty
  but **no level** — the curve clamps, and a clamp is a floor, not a ceiling. Claiming "B1"
  because that is where the curve stops would be an overclaim.
- **A level is never derived from the DWDS class.** Seven coarse buckets cannot support a six-band
  CEFR claim, and class 0 is an undifferentiated rare tail.
- **German difficulty is flat above B1** (everything clamps to one value). Within A1–B1 it is
  continuous. This is the weakest part of the German ladder and the next thing to improve.

There is **no official German C1/C2 vocabulary list** — none was ever published — and the A1–B1
Goethe lists may not be redistributed, so they are read only for offline calibration and never
stored. Every German level ships with `levelEstimated: true`.

Paragraph difficulty is the mean difficulty of its content words, which puts text and item
difficulty on one scale. It is a coarse proxy: the proper i+1 metric is lexical *coverage* against
a specific learner, which needs the ability model (Phase 2).

## API

```
GET   /api/me                       learner + current track
PATCH /api/me/track                 switch track
GET   /api/paragraphs               paragraphs for the track, tokenized server-side
GET   /api/paragraphs/:id           one paragraph
GET   /api/words?status=…           vocabulary for the track
GET   /api/words/:lemmaKey          one entry
POST  /api/words/mark               mark an occurrence (span) → appends a mark event
POST  /api/words/ignore             un-mark an occurrence → appends an unmark event
POST  /api/words/batch              batch lookup by lemmaKey
POST  /api/marks/batch              marks for a paragraph, keyed by charStart
POST  /api/events                   append events (single, or a batched exposure)
GET   /api/provenance               data sources and licences
```

`POST /api/paragraph-words/batch` is gone (410) — occurrences are no longer identified by index.

## Commands

```bash
npm run dev              # development server
npm test                 # tokenizer, importer and learner-model tests
npm run typecheck        # tsc --noEmit
npm run fetch:data       # download open datasets (--full for the large corpora)
npm run import:english      # CEFR-J + Octanove → Word  (9,779 rows)
npm run import:german       # DWDS + kaikki morphology → Word  (-- --with-kaikki)
npm run import:licences     # regenerate LICENSES/
npm run export:frequency    # word list → wordfreq Zipf table (needs .venv-data)
                            #   python3 -m venv .venv-data && ./.venv-data/bin/pip install -r src/scripts/import/requirements-wordfreq.txt
                            #   (jieba is required — without it wordfreq cannot tokenise Chinese)
npm run import:frequency    # attach Zipf, scored on the best of a word's forms
npm run import:german-rank  # Leipzig corpus ranks (splits the DWDS rare tail)
npm run import:ding         # German→English glosses (GPL-3+, own collection)
npm run import:cedict       # English→Chinese glosses (CC BY-SA, own collection)
npm run import:kaikki        # German inflections + glosses where ding has no headword
npm run recompute:difficulty  # fit the curve and write difficulty  (-- --with-goethe-anchors)
npm run seed                # reset and seed demo data
```

## Licensing

Every external source is declared in `src/lib/licence/datasets.ts` with its licence, whether it is
commercially usable, and whether it imposes share-alike or copyleft. `npm run import:licences`
generates `LICENSES/`, and the importers call `assertShippable()` so an offline-only source cannot
be written to the database by accident.

Nine of the sixteen declared datasets are share-alike or copyleft, which is an architectural
constraint rather than a footnote: keep each source in its own collection, and never merge licensed
gloss text into a collection with proprietary text.

Three datasets are **offline-calibration-only** and must never be committed, shipped, or imported:
the Goethe/DTZ/telc wordlists (withheld by their own terms), DeReWo (CC BY-NC), and the existing
Minimax machine-translated glosses (vendor terms unverified).
