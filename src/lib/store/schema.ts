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
  starred          INTEGER NOT NULL DEFAULT 0,
  promptSnapshot   TEXT,
  createdAt        INTEGER NOT NULL,
  updatedAt        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS paragraphs_brief ON paragraphs (targetLang, briefId) WHERE briefId IS NOT NULL;
CREATE INDEX IF NOT EXISTS paragraphs_read ON paragraphs (targetLang, difficulty, createdAt);
CREATE INDEX IF NOT EXISTS paragraphs_recent ON paragraphs (targetLang, createdAt DESC);
CREATE INDEX IF NOT EXISTS paragraphs_buffer ON paragraphs (targetLang, buffered);

-- ── Learner ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  -- The token itself is never stored: a leak of this table must not be a set of usable sessions.
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  -- When this session last did something; presence is derived from it.
  lastSeenAt INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (userId);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL UNIQUE,
  track      TEXT NOT NULL,
  uiLocale   TEXT NOT NULL DEFAULT 'en',
  -- Dev-stage auth: any string is a valid username, any string is a valid password. What is *not*
  -- negotiable is how the password is stored — scrypt with a per-user salt, so a leaked file is not
  -- a leaked set of passwords even in a dev database.
  username     TEXT UNIQUE,
  passwordHash TEXT,
  passwordSalt TEXT,
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

-- ── Passage packages ────────────────────────────────────────────────────────

-- A passage, tokenised and glossed once, at the moment it is written.
--
-- The reader used to tokenise and gloss on every view: six dictionary queries and ~150ms of CPU to
-- answer the same question about the same unchanging text. The package is that answer, computed where
-- the dictionary lives (the writer) and stored beside the passage, so reading is one row and the
-- dictionary never has to be present on the host that serves readers.
-- D1 rejects a statement over ~100KB, and a packed passage is around 60KB of JSON, so the payload is
-- stored in chunks. Readers concatenate them in order; nothing else changes.
CREATE TABLE IF NOT EXISTS package_chunks (
  paragraphId TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (paragraphId, idx)
);

CREATE TABLE IF NOT EXISTS passage_packages (
  paragraphId TEXT PRIMARY KEY,
  -- Version of the tokeniser and gloss pipeline that produced this. A package with an older version
  -- is rebuilt lazily by the writer, never repaired on the read path.
  version     INTEGER NOT NULL DEFAULT 1,
  data        TEXT NOT NULL,
  createdAt   INTEGER NOT NULL
);

-- The Pi's reading of a passage, for one learner.
--
-- The unknown count is a function of this learner's whole evidence, and only the Pi can fold that. So
-- the Pi computes it when it pulls and writes the answer here; the reader serves this row and falls
-- back to the model prediction until it exists. One estimator, one number.
CREATE TABLE IF NOT EXISTS reader_bands (
  userId      TEXT NOT NULL,
  paragraphId TEXT NOT NULL,
  targetLang  TEXT NOT NULL,
  unknownCount INTEGER NOT NULL,
  coverage    REAL NOT NULL,
  computedAt  INTEGER NOT NULL,
  PRIMARY KEY (userId, paragraphId)
);

-- What readers asked for.
--
-- Generation lives on the Pi, which has the vocabulary, and Cloudflare cannot call it. So a request to
-- write a passage is queued here and the Pi's pull loop drains the queue: the button works on either
-- host, and nothing waits on the other being awake.
CREATE TABLE IF NOT EXISTS generation_requests (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL,
  targetLang TEXT NOT NULL,
  level      TEXT,
  topic      TEXT,
  createdAt  INTEGER NOT NULL,
  takenAt    INTEGER
);

-- ── The word book ─────────────────────────────────────────────────────────────
--
-- The replacement for the dictionary's three jobs in one table: what level a word is, what it means,
-- and how it inflects. Built from curated sources (Goethe for level, other lists for translation) rather
-- than derived from frequency, and small on purpose — a few thousand words, not 290,000.
--
-- It is a *new* dictionary, not a set of columns on the words table: its rows are its own, its provenance is
-- recorded per field, and nothing here depends on the old tables being present.
CREATE TABLE IF NOT EXISTS wordbook (
  -- Two tracks, one table: the German book and the English book differ in source and in gloss
  -- language, not in shape.
  targetLang        TEXT NOT NULL,
  lemmaKey          TEXT NOT NULL,
  word              TEXT NOT NULL,
  -- der/die/das for nouns, NULL otherwise.
  article           TEXT,
  level             TEXT,
  levelSource       TEXT,
  -- JSON array of the listed forms: plural endings, verb principal parts.
  forms             TEXT,
  translation       TEXT,
  translationSource TEXT,
  updatedAt         INTEGER NOT NULL,
  PRIMARY KEY (targetLang, lemmaKey)
);

CREATE INDEX IF NOT EXISTS wordbook_level ON wordbook (targetLang, level);

-- ── The pool ─────────────────────────────────────────────────────────────────

-- Who has read what is in circulation.
--
-- A passage used to leave the pool the moment one reader took it, so the second reader cost a
-- generation. Now a passage stays available until three people have read it: the pool is shared, and
-- "depth" is per reader — what *you* have not read yet — so a new reader arrives to a full pool
-- rather than to the wreckage of somebody else's press.
CREATE TABLE IF NOT EXISTS pool_reads (
  paragraphId TEXT NOT NULL,
  userId      TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  PRIMARY KEY (paragraphId, userId)
);
CREATE INDEX IF NOT EXISTS pool_reads_user ON pool_reads (userId);

-- ── Stars ───────────────────────────────────────────────────────────────────

-- A star belongs to a reader. It used to be a column on the passage, which was fine while there was
-- one user and wrong the moment there were two: one person's star appeared on everyone's copy, and
-- pruning treated a passage as protected for everybody because one person had kept it.
CREATE TABLE IF NOT EXISTS paragraph_stars (
  userId      TEXT NOT NULL,
  paragraphId TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  PRIMARY KEY (userId, paragraphId)
);
CREATE INDEX IF NOT EXISTS paragraph_stars_passage ON paragraph_stars (paragraphId);

-- ── Calibration ──────────────────────────────────────────────────────────────

-- What the reader said a passage's difficulty was, recorded beside what the app computed and what
-- it believed about the reader at that moment. Three opinions of the same thing, kept together so
-- they can be compared later: the app's band comes from per-word probabilities, the reader's comes
-- from having read it, and the estimate comes from everything they have ever marked.
CREATE TABLE IF NOT EXISTS difficulty_votes (
  id           TEXT PRIMARY KEY,
  userId       TEXT NOT NULL,
  targetLang   TEXT NOT NULL,
  paragraphId  TEXT NOT NULL,
  -- The reader's verdict, in the same vocabulary as the computed band.
  userBand     TEXT NOT NULL,
  -- What the app computed, captured at the moment of the vote: recalibrating the model later must
  -- not rewrite what it used to say.
  computedBand TEXT NOT NULL,
  unknownCount INTEGER NOT NULL DEFAULT 0,
  coverage     REAL NOT NULL DEFAULT -1,
  -- The ability estimate at the time, so a disagreement can be read against how sure the app was.
  theta        REAL NOT NULL,
  se           REAL NOT NULL,
  n            REAL NOT NULL DEFAULT 0,
  levelPoint   TEXT NOT NULL,
  levelLow     TEXT NOT NULL,
  levelHigh    TEXT NOT NULL,
  -- 0 when the reader left the app's own band alone, 1 when they changed it. Leaving it alone is
  -- agreement, and it has to be recorded: a record of only the changed answers would report a
  -- disagreement rate of 100% by construction.
  explicit     INTEGER NOT NULL DEFAULT 0,
  createdAt    INTEGER NOT NULL
);
-- One opinion per passage per reader. Opening it again revises that opinion rather than adding a
-- second, so the agreement rate is per passage and not per visit.
CREATE UNIQUE INDEX IF NOT EXISTS difficulty_votes_identity ON difficulty_votes (userId, paragraphId);
CREATE INDEX IF NOT EXISTS difficulty_votes_recent ON difficulty_votes (userId, createdAt DESC);
CREATE INDEX IF NOT EXISTS difficulty_votes_agreement ON difficulty_votes (computedBand, userBand);
`;
