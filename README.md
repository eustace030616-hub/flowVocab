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
│   │   └── user.ts                learner identity (cookie; not auth)
│   └── licence/
│       ├── datasets.ts            every source + its licence, as code
│       └── index.ts               LICENSES/ manifest generation
├── models/
│   ├── Paragraph.ts               content, language, difficulty, coverage
│   ├── Word.ts                    shared reference data: (targetLang, lemma, pos), glosses
│   ├── WordState.ts               PER LEARNER: status, timesMet, unfamiliarity, …
│   ├── Mark.ts                    one learner's mark on one character span
│   ├── Event.ts                   append-only log: the source of truth
│   ├── User.ts                    learner + current track
│   └── Provenance.ts              per-dataset licence records
└── scripts/
    ├── seed.ts, seed-data.ts      demo content for both tracks
    └── import/                    fetch-data.sh, import-english, import-german, write-licences
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

## Difficulty and levels

Item difficulty is continuous in `[0,1]`; CEFR is a label on top of it.

| Track | Source | Honest status |
|---|---|---|
| English | CEFR-J v1.5 + Octanove C1/C2, re-merged on `(lemma, pos)` | anchored to real CEFR lists |
| German | DWDS Häufigkeitsklasse + an LLM-assigned CEFR prior | **estimated above A2** |

There is **no official German C1/C2 vocabulary list** — none was ever published — and the A1–B1
Goethe lists may not be redistributed. So German labels ship with `levelEstimated: true`, and the
interface is expected to say so rather than imply a measurement.

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
npm run import:english   # CEFR-J + Octanove → Word
npm run import:german    # DWDS + estimated levels → Word
npm run import:licences  # regenerate LICENSES/
npm run seed             # reset and seed demo data
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
