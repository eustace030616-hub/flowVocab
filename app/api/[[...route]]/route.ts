import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getCookie, setCookie } from "hono/cookie";

import { connectDB } from "@/src/lib/db";
import { Paragraph } from "@/src/models/Paragraph";
import { Word } from "@/src/models/Word";
import { Mark } from "@/src/models/Mark";
import { Provenance } from "@/src/models/Provenance";
import { isTargetLang, isTrackId, TRACKS, type GlossLang, type TargetLang } from "@/src/lib/lang";
import {
  resolveUser,
  setTrack,
  trackOf,
  USER_COOKIE,
  type ResolvedUser,
} from "@/src/lib/learner/user";
import {
  appendEvent,
  appendExposureBatch,
  recomputeWordState,
} from "@/src/lib/learner/state";
import { tokenizeWithLexicon, wordsForSpans } from "@/src/lib/learner/lexicon";
import { wordSpans, TOKENIZER_VERSION } from "@/src/lib/tokenize";

type Variables = { user: ResolvedUser };

/** Shape of an embedded gloss as it comes back from a lean() query. */
interface StoredGloss {
  lang: string;
  text: string;
  source: string;
  generated: boolean;
}

const app = new Hono<{ Variables: Variables }>().basePath("/api");

const EVENT_TYPES = [
  "exposure",
  "lookup",
  "mark",
  "unmark",
  "confirmed",
  "not_sure",
] as const;

/**
 * Resolve the learner before every route.
 *
 * Identity is a signed-less opaque cookie in Phase 0 — enough to make every learner-model read
 * and write per-user, which is the actual requirement. Swapping in real auth means changing
 * `resolveUser` only.
 */
app.use("*", async (c, next) => {
  await connectDB();
  const existing = getCookie(c, USER_COOKIE);
  const { user, created } = await resolveUser(existing);
  if (created) {
    setCookie(c, USER_COOKIE, user.userId, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  c.set("user", user);
  await next();
});

/** Which target language a request concerns: explicit value if valid, else the user's track. */
function targetLangFor(
  c: { req: { query: (k: string) => string | undefined }; get: (k: "user") => ResolvedUser },
  body?: { targetLang?: unknown },
): TargetLang {
  const explicit = c.req.query("targetLang") ?? body?.targetLang;
  if (isTargetLang(explicit)) return explicit;
  return trackOf(c.get("user")).targetLang;
}

function glossLangFor(c: { get: (k: "user") => ResolvedUser }): GlossLang {
  return trackOf(c.get("user")).glossLang;
}

// ── Learner ───────────────────────────────────────────────────────────────────

app.get("/me", (c) => {
  const user = c.get("user");
  const track = trackOf(user);
  return c.json({ ...user, ...track, tracks: Object.values(TRACKS) });
});

app.patch("/me/track", async (c) => {
  const body = (await c.req.json()) as { track?: unknown };
  if (!isTrackId(body.track)) {
    return c.json({ error: "unknown track", allowed: Object.keys(TRACKS) }, 400);
  }
  const user = c.get("user");
  const updated = await setTrack(user.userId, body.track);
  return c.json({ ...updated, ...trackOf(updated) });
});

// ── Paragraphs ────────────────────────────────────────────────────────────────

/**
 * Paragraphs for the learner's track, tokenized **server-side**.
 *
 * The client renders the spans it is given rather than splitting the text itself, so the span a
 * learner clicks and the lemma the server records cannot drift apart — which is exactly what
 * happened when the client split on spaces and the server keyed marks by array index.
 */
app.get("/paragraphs", async (c) => {
  const user = c.get("user");
  const targetLang = targetLangFor(c);
  const glossLang = glossLangFor(c);

  const paragraphs = await Paragraph.find({ targetLang })
    .sort({ difficulty: 1, createdAt: 1 })
    .lean();

  const out = [];
  for (const paragraph of paragraphs) {
    const spans = await tokenizeWithLexicon(paragraph.content, targetLang);

    // Marks this learner has already made, keyed by where they made them.
    const marks = await Mark.find({ userId: user.userId, paragraphId: paragraph._id }).lean();
    const marked: Record<string, string> = {};
    for (const mark of marks) marked[`${mark.charStart}`] = mark.status;

    // Vocabulary records behind the spans, so the popover has a gloss without a second round trip.
    const lexicon = await wordsForSpans(targetLang, spans);
    const keys = [...lexicon.keys()];
    const words = keys.length
      ? await Word.find({ targetLang, lemmaKey: { $in: keys } })
          .select("lemmaKey lemma pos glosses level levelEstimated difficulty frequency article plural status timesMet unfamiliarity lookupCount exposureCount")
          .lean()
      : [];

    const vocabulary: Record<string, unknown> = {};
    for (const word of words) {
      if (vocabulary[word.lemmaKey]) continue;
      const gloss =
        (word.glosses as StoredGloss[]).find((g) => g.lang === glossLang) ??
        (word.glosses as StoredGloss[])[0] ??
        null;
      vocabulary[word.lemmaKey] = {
        lemma: word.lemma,
        pos: word.pos,
        gloss: gloss ? gloss.text : null,
        glossGenerated: gloss ? gloss.generated : null,
        glossSource: gloss ? gloss.source : null,
        level: word.level,
        levelEstimated: word.levelEstimated,
        difficulty: word.difficulty,
        frequency: word.frequency,
        article: word.article ?? null,
        plural: word.plural ?? null,
        status: word.status,
        timesMet: word.timesMet,
        unfamiliarity: word.unfamiliarity,
        lookupCount: word.lookupCount,
        exposureCount: word.exposureCount,
      };
    }

    out.push({
      ...paragraph,
      spans,
      marked,
      vocabulary,
      tokenizerVersion: TOKENIZER_VERSION,
    });
  }

  return c.json(out);
});

app.get("/paragraphs/:id", async (c) => {
  const paragraph = await Paragraph.findById(c.req.param("id")).lean();
  if (!paragraph) return c.json({ error: "Not found" }, 404);
  return c.json(paragraph);
});

// ── Words ─────────────────────────────────────────────────────────────────────

app.get("/words", async (c) => {
  const targetLang = targetLangFor(c);
  const status = c.req.query("status") || "unfamiliar";
  const words = await Word.find({ targetLang, status }).limit(500).lean();
  return c.json(words);
});

app.get("/words/:lemmaKey", async (c) => {
  const targetLang = targetLangFor(c);
  const word = await Word.findOne({
    targetLang,
    lemmaKey: c.req.param("lemmaKey").toLowerCase(),
  }).lean();
  if (!word) return c.json({ error: "Not found" }, 404);
  return c.json(word);
});

/**
 * Mark an occurrence.
 *
 * Writes three things: an upserted `Word`, a `Mark` at the character span the learner touched,
 * and an append-only `mark` event. The word's counters are then *recomputed* from the log rather
 * than incremented in place — so they are repairable, and un-marking cannot destroy history.
 */
app.post("/words/mark", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as {
    targetLang?: unknown;
    surface?: string;
    lemma?: string;
    lemmaKey?: string;
    pos?: string;
    paragraphId?: string;
    charStart?: number;
    charEnd?: number;
  };

  const targetLang = targetLangFor(c, body);
  const lemmaKey = (body.lemmaKey || body.surface || "").toLowerCase().trim();
  if (!lemmaKey || !body.paragraphId || typeof body.charStart !== "number" || typeof body.charEnd !== "number") {
    return c.json(
      { error: "lemmaKey (or surface), paragraphId, charStart and charEnd are required" },
      400,
    );
  }

  const pos = body.pos ?? "";
  const word = await Word.findOneAndUpdate(
    { targetLang, lemmaKey, pos },
    {
      $setOnInsert: {
        targetLang,
        lemmaKey,
        pos,
        lemma: body.lemma || body.surface || lemmaKey,
        surfaceForms: body.surface ? [body.surface] : [],
        glosses: [],
        frequency: {},
        level: null,
        levelEstimated: false,
        levelSource: null,
        difficulty: -1,
        status: "unfamiliar",
        timesMet: 0,
        unfamiliarity: 0,
        lookupCount: 0,
        exposureCount: 0,
      },
      $addToSet: body.surface ? { surfaceForms: body.surface } : {},
    },
    { new: true, upsert: true },
  );

  await Mark.findOneAndUpdate(
    {
      userId: user.userId,
      paragraphId: body.paragraphId,
      charStart: body.charStart,
      charEnd: body.charEnd,
    },
    {
      userId: user.userId,
      targetLang,
      paragraphId: body.paragraphId,
      wordId: word._id,
      surface: body.surface ?? word.lemma,
      lemmaKey,
      charStart: body.charStart,
      charEnd: body.charEnd,
      tokenizerVersion: TOKENIZER_VERSION,
      status: "marked",
      markedAt: new Date(),
    },
    { upsert: true, new: true },
  );

  await appendEvent({
    userId: user.userId,
    targetLang,
    type: "mark",
    paragraphId: body.paragraphId,
    wordId: word._id,
    surface: body.surface,
    lemmaKey,
    charStart: body.charStart,
    charEnd: body.charEnd,
  });

  const state = await recomputeWordState(user.userId, targetLang, lemmaKey, word._id);
  return c.json({ word, state }, 201);
});

/**
 * Un-mark an occurrence.
 *
 * Kept on the old path for compatibility, but the semantics changed: this appends an `unmark`
 * event and recomputes, instead of decrementing a counter that was the only copy of the history.
 */
app.post("/words/ignore", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as {
    targetLang?: unknown;
    lemmaKey?: string;
    surface?: string;
    paragraphId?: string;
    charStart?: number;
    charEnd?: number;
  };

  const targetLang = targetLangFor(c, body);
  const lemmaKey = (body.lemmaKey || body.surface || "").toLowerCase().trim();
  if (!lemmaKey) return c.json({ error: "lemmaKey is required" }, 400);

  if (body.paragraphId && typeof body.charStart === "number" && typeof body.charEnd === "number") {
    await Mark.findOneAndUpdate(
      {
        userId: user.userId,
        paragraphId: body.paragraphId,
        charStart: body.charStart,
        charEnd: body.charEnd,
      },
      { status: "ignored" },
    );
  }

  await appendEvent({
    userId: user.userId,
    targetLang,
    type: "unmark",
    paragraphId: body.paragraphId,
    surface: body.surface,
    lemmaKey,
    charStart: body.charStart,
    charEnd: body.charEnd,
  });

  const state = await recomputeWordState(user.userId, targetLang, lemmaKey);
  return c.json({ state });
});

/** Batch vocabulary lookup, keyed by lemma (not by spelling — that is the point of lemmaKey). */
app.post("/words/batch", async (c) => {
  const body = (await c.req.json()) as { targetLang?: unknown; lemmaKeys?: string[]; words?: string[] };
  const targetLang = targetLangFor(c, body);
  const keys = (body.lemmaKeys ?? body.words ?? []).map((k) => k.toLowerCase());

  const words = await Word.find({ targetLang, lemmaKey: { $in: keys } })
    .select("lemma lemmaKey pos glosses level levelEstimated difficulty status timesMet unfamiliarity lookupCount exposureCount")
    .lean();
  return c.json(words);
});

// ── Marks ─────────────────────────────────────────────────────────────────────

/** Marks for one paragraph, keyed by charStart so the renderer can match them to spans. */
app.post("/marks/batch", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as { paragraphId?: string; targetLang?: unknown };
  if (!body.paragraphId) return c.json({ error: "paragraphId is required" }, 400);

  const marks = await Mark.find({ userId: user.userId, paragraphId: body.paragraphId }).lean();
  const result: Record<string, string> = {};
  for (const mark of marks) result[`${mark.charStart}`] = mark.status;
  return c.json(result);
});

/** Removed in Phase 0: occurrence identity is a character span, not an array index. */
app.post("/paragraph-words/batch", (c) =>
  c.json(
    {
      error: "gone",
      message:
        "Occurrences are no longer identified by array index. Use POST /api/marks/batch, which returns statuses keyed by charStart.",
    },
    410,
  ),
);

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * Append events. There is deliberately no update or delete counterpart: the log is the source
 * of truth and `Word`'s counters are a cache derived from it.
 */
app.post("/events", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as {
    targetLang?: unknown;
    type?: string;
    source?: "web" | "reader" | "placement" | "import";
    sessionId?: string;
    paragraphId?: string;
    wordId?: string;
    surface?: string;
    lemmaKey?: string;
    charStart?: number;
    charEnd?: number;
    items?: Array<{ surface: string; lemmaKey: string; charStart?: number; charEnd?: number }>;
  };

  const targetLang = targetLangFor(c, body);
  const type = body.type;

  if (type === "exposure") {
    if (!Array.isArray(body.items) || body.items.length === 0 || !body.paragraphId) {
      return c.json({ error: "exposure events require paragraphId and a non-empty items array" }, 400);
    }
    const event = await appendExposureBatch({
      userId: user.userId,
      targetLang,
      paragraphId: body.paragraphId,
      sessionId: body.sessionId,
      items: body.items,
      source: body.source ?? "web",
    });
    return c.json({ ok: true, appended: body.items.length, event: event?._id ?? null }, 201);
  }

  if (!type || !(EVENT_TYPES as readonly string[]).includes(type)) {
    return c.json({ error: "unknown event type", allowed: EVENT_TYPES }, 400);
  }
  if (!body.lemmaKey) {
    return c.json({ error: "lemmaKey is required for single-item events" }, 400);
  }

  const event = await appendEvent({
    userId: user.userId,
    targetLang,
    type: type as (typeof EVENT_TYPES)[number],
    source: body.source ?? "web",
    sessionId: body.sessionId,
    paragraphId: body.paragraphId,
    wordId: body.wordId,
    surface: body.surface,
    lemmaKey: body.lemmaKey,
    charStart: body.charStart,
    charEnd: body.charEnd,
  });

  const state = await recomputeWordState(user.userId, targetLang, body.lemmaKey);
  return c.json({ ok: true, event: event._id, state }, 201);
});

// ── Licences ──────────────────────────────────────────────────────────────────

/** Data sources, so the attribution screen is generated from data rather than maintained by hand. */
app.get("/provenance", async (c) => {
  const datasets = await Provenance.find().sort({ dataset: 1 }).lean();
  return c.json(datasets);
});

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);
