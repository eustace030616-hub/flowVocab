/**
 * The SQLite schema.
 *
 * One file, no server. The app is single-user, offline-first and read-mostly, with derived lookup
 * tables — which is what SQLite is for, and its cost is a file rather than a daemon.
 *
 * The schema is written in portable SQL on purpose. Nothing here is SQLite-only except
 * `ON CONFLICT … DO UPDATE`, which is the one dialect difference that matters for a port to MySQL
 * (`ON DUPLICATE KEY UPDATE`) — the importers are built out of upserts, so that is the statement to
 * look at first if you take it there.
 *
 * Identity is kept as the 24-character hex string the documents used, so existing identifiers,
 * bookmarks and links keep working and the migration is a straight copy rather than a renumbering.
 *
 * ## Type choices
 *
 *   TEXT     strings, and JSON for anything that was an array or a mixed object
 *   INTEGER  numbers, booleans (0/1), and timestamps in epoch milliseconds
 *   REAL     difficulty, theta, weights — anything fractional
 *
 * Timestamps as integers because every query on them is a range or an ordering, never a formatting
 * operation.
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Dictionary ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS words (
  id              TEXT PRIMARY KEY,
  targetLang      TEXT NOT NULL,
  lemmaKey        TEXT NOT NULL,
  lemma           TEXT NOT NULL,
  pos             TEXT NOT NULL DEFAULT '',
  origin          TEXT NOT NULL DEFAULT 'learner',
  surfaceForms    TEXT NOT NULL DEFAULT '[]',
  level           TEXT,
  levelEstimated  INTEGER NOT NULL DEFAULT 0,
  levelSource     TEXT,
  difficulty      REAL NOT NULL DEFAULT -1,
  -- Frequency evidence, kept as JSON: it is a bag of named sources that grows with each import and
  -- is never queried by name, only read whole.
  frequency       TEXT NOT NULL DEFAULT '{}',
  article         TEXT,
  plural          TEXT,
  cognateWithEn   INTEGER NOT NULL DEFAULT 0,
  falseFriend     INTEGER NOT NULL DEFAULT 0,
  createdAt       INTEGER NOT NULL
);
-- Identity is (language, lemma, part of speech): the same spelling as a noun and a verb are different
-- vocabulary entries, and merging them split a learner's history across two rows.
CREATE UNIQUE INDEX IF NOT EXISTS words_identity ON words (targetLang, lemmaKey, pos);
CREATE INDEX IF NOT EXISTS words_lookup ON words (targetLang, origin, lemmaKey);
CREATE INDEX IF NOT EXISTS words_difficulty ON words (targetLang, difficulty);

CREATE TABLE IF NOT EXISTS glosses (
  id          TEXT PRIMARY KEY,
  targetLang  TEXT NOT NULL,
  lemmaKey    TEXT NOT NULL,
  wordId      TEXT,
  lang        TEXT NOT NULL,
  text        TEXT NOT NULL,
  sense       TEXT,
  pos         TEXT NOT NULL DEFAULT '',
  termPos     TEXT,
  source      TEXT NOT NULL,
  license     TEXT NOT NULL,
  generated   INTEGER NOT NULL DEFAULT 0,
  rank        INTEGER NOT NULL DEFAULT 0,
  weight      REAL,
  createdAt   INTEGER NOT NULL
);
-- The licence seam: one row per translation per source, so share-alike text stays separable and a
-- source can be dropped in one statement.
CREATE UNIQUE INDEX IF NOT EXISTS glosses_identity ON glosses (targetLang, lemmaKey, pos, lang, source, text);
CREATE INDEX IF NOT EXISTS glosses_read ON glosses (targetLang, lemmaKey, pos, lang, rank);
CREATE INDEX IF NOT EXISTS glosses_source ON glosses (source);

CREATE TABLE IF NOT EXISTS inflections (
  id            TEXT PRIMARY KEY,
  targetLang    TEXT NOT NULL,
  form          TEXT NOT NULL,
  base          TEXT NOT NULL,
  baseLemmaKey  TEXT NOT NULL,
  pos           TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL,
  license       TEXT NOT NULL,
  createdAt     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS inflections_identity ON inflections (targetLang, form, baseLemmaKey, pos, source);
CREATE INDEX IF NOT EXISTS inflections_read ON inflections (targetLang, form);

CREATE TABLE IF NOT EXISTS separations (
  id          TEXT PRIMARY KEY,
  targetLang  TEXT NOT NULL,
  particle    TEXT NOT NULL,
  verb        TEXT NOT NULL,
  merged      TEXT NOT NULL,
  source      TEXT NOT NULL,
  createdAt   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS separations_identity ON separations (targetLang, particle, verb);
CREATE INDEX IF NOT EXISTS separations_read ON separations (targetLang, particle);

CREATE TABLE IF NOT EXISTS compounds (
  id          TEXT PRIMARY KEY,
  targetLang  TEXT NOT NULL,
  form        TEXT NOT NULL,
  parts       TEXT NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL,
  createdAt   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS compounds_identity ON compounds (targetLang, form);

CREATE TABLE IF NOT EXISTS provenance (
  id            TEXT PRIMARY KEY,
  dataset       TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  license       TEXT NOT NULL,
  licenseUrl    TEXT,
  attribution   TEXT NOT NULL,
  commercialUse INTEGER NOT NULL,
  shareAlike    INTEGER NOT NULL DEFAULT 0,
  copyleft      INTEGER NOT NULL DEFAULT 0,
  offlineOnly   INTEGER NOT NULL DEFAULT 0,
  retrievedAt   INTEGER,
  rowCount      INTEGER,
  contributesTo TEXT NOT NULL DEFAULT '[]',
  notes         TEXT
);

-- ── Content ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paragraphs (
  id               TEXT PRIMARY KEY,
  targetLang       TEXT NOT NULL,
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  topic            TEXT,
  wordCount        INTEGER NOT NULL DEFAULT 0,
  level            TEXT,
  difficulty       REAL NOT NULL DEFAULT -1,
  difficultySource TEXT,
  coverage         REAL NOT NULL DEFAULT -1,
  tokenizerVersion INTEGER NOT NULL DEFAULT 1,
  source           TEXT NOT NULL DEFAULT 'seed',
  -- The brief a generated passage fulfils, and the prompt that produced it: provenance for text no
  -- corpus supplied.
  briefId          TEXT,
  buffered         INTEGER NOT NULL DEFAULT 0,
  promptSnapshot   TEXT,
  createdAt        INTEGER NOT NULL,
  updatedAt        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS paragraphs_brief ON paragraphs (targetLang, briefId) WHERE briefId IS NOT NULL;
CREATE INDEX IF NOT EXISTS paragraphs_read ON paragraphs (targetLang, difficulty, createdAt);
CREATE INDEX IF NOT EXISTS paragraphs_recent ON paragraphs (targetLang, createdAt DESC);
CREATE INDEX IF NOT EXISTS paragraphs_buffer ON paragraphs (targetLang, buffered);

-- ── Learner ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL UNIQUE,
  track      TEXT NOT NULL,
  uiLocale   TEXT NOT NULL DEFAULT 'en',
  createdAt  INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marks (
  id               TEXT PRIMARY KEY,
  userId           TEXT NOT NULL,
  targetLang       TEXT NOT NULL,
  paragraphId      TEXT NOT NULL,
  wordId           TEXT NOT NULL,
  surface          TEXT NOT NULL,
  lemmaKey         TEXT NOT NULL,
  charStart        INTEGER NOT NULL,
  charEnd          INTEGER NOT NULL,
  tokenizerVersion INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'marked',
  markedAt         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS marks_identity ON marks (userId, paragraphId, charStart, charEnd);
CREATE INDEX IF NOT EXISTS marks_paragraph ON marks (userId, paragraphId);
CREATE INDEX IF NOT EXISTS marks_language ON marks (userId, targetLang, status);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL,
  targetLang  TEXT NOT NULL,
  type        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'web',
  sessionId   TEXT,
  paragraphId TEXT,
  wordId      TEXT,
  surface     TEXT,
  lemmaKey    TEXT,
  charStart   INTEGER,
  charEnd     INTEGER,
  -- Exposure batches carry their words here; the append-only log is the truth for the learner model.
  items       TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user_time ON events (userId, targetLang, ts DESC);
CREATE INDEX IF NOT EXISTS events_user_word ON events (userId, targetLang, lemmaKey, ts DESC);

CREATE TABLE IF NOT EXISTS word_states (
  id             TEXT PRIMARY KEY,
  userId         TEXT NOT NULL,
  targetLang     TEXT NOT NULL,
  lemmaKey       TEXT NOT NULL,
  wordId         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unfamiliar',
  timesMet       INTEGER NOT NULL DEFAULT 0,
  unfamiliarity  INTEGER NOT NULL DEFAULT 0,
  lookupCount    INTEGER NOT NULL DEFAULT 0,
  exposureCount  INTEGER NOT NULL DEFAULT 0,
  updatedAt      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS word_states_identity ON word_states (userId, targetLang, lemmaKey);

CREATE TABLE IF NOT EXISTS ability_states (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL,
  targetLang  TEXT NOT NULL,
  theta       REAL NOT NULL,
  se          REAL NOT NULL,
  n           REAL NOT NULL DEFAULT 0,
  level       TEXT,
  levelLow    TEXT NOT NULL,
  levelHigh   TEXT NOT NULL,
  priorTheta  REAL,
  updatedAt   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ability_states_identity ON ability_states (userId, targetLang);

CREATE TABLE IF NOT EXISTS placement_sessions (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL,
  targetLang  TEXT NOT NULL,
  seed        INTEGER NOT NULL,
  items       TEXT NOT NULL DEFAULT '[]',
  responses   TEXT NOT NULL DEFAULT '[]',
  completedAt INTEGER,
  score       TEXT,
  createdAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS placement_recent ON placement_sessions (userId, targetLang, createdAt DESC);
`;
