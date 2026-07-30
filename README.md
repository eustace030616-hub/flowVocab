# Vocab App

An interactive vocabulary learning app. Read paragraphs, click unfamiliar words to track them, and watch your mastery grow as you encounter words across different topics.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router) + Tailwind CSS |
| API | Hono (embedded in Next.js via `hono/vercel`) |
| Database | MongoDB 8 + Mongoose |
| Container | Docker Compose |

## Quick start

```bash
docker compose up --build -d
docker compose exec web npx tsx src/scripts/seed.ts
```

Open http://localhost:3000.

## Project structure

```
app/
├── page.tsx                       the entire interactive paragraph viewer
├── layout.tsx                     root HTML shell
└── api/[[...route]]/route.ts      all API endpoints (Hono)

src/
├── lib/db.ts                      MongoDB connection
├── models/
│   ├── Paragraph.ts               title, content, topic, wordCount
│   ├── Word.ts                    word, definition, timesMet, unfamiliarity
│   └── ParagraphWord.ts           joins paragraph ↔ word at a specific index
└── scripts/
    └── seed.ts                    4 paragraphs + 10 words with definitions
```

## Data model

```
Paragraph ─────────── Word ─────────── ParagraphWord
title                  word              paragraphId
content                definition        wordId
topic (enum)           timesMet (↑)      wordIndex
wordCount              unfamiliarity     status: marked | ignored | known
                       status
```

- **timesMet**: increments on every click, never decrements (permanent history)
- **unfamiliarity**: click +1, ignore -1. Hits 0 → mastered
- **ParagraphWord**: persists which specific word occurrence was marked in which paragraph

## Daily commands

```bash
docker compose up -d       # start
docker compose down         # stop
docker compose exec web npx tsx src/scripts/seed.ts   # reset data
```

## API

```
GET   /api/paragraphs               all paragraphs
POST  /api/words/mark               mark a word (timesMet++, unfamiliarity++)
POST  /api/words/ignore             decrement unfamiliarity
POST  /api/words/batch              lookup multiple words
POST  /api/paragraph-words/batch    which words are marked in a paragraph
```
