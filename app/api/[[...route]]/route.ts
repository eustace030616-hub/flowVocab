import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getCookie, setCookie } from "hono/cookie";

import { connectDB } from "@/src/lib/db";
import { Paragraph } from "@/src/models/Paragraph";
import { Word } from "@/src/models/Word";
import { Mark } from "@/src/models/Mark";
import { Provenance } from "@/src/models/Provenance";
import {
  glossLangFor,
  isTargetLang,
  isTrackId,
  TRACKS,
  type TargetLang,
} from "@/src/lib/lang";
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
  statesFor,
} from "@/src/lib/learner/state";
import { WordState } from "@/src/models/WordState";
import { tokenizeWithLexicon, wordsForSpans } from "@/src/lib/learner/lexicon";
import { pickExistingWord } from "@/src/lib/learner/resolve";
import { allGlossesFor, glossesByLemma, pickGloss } from "@/src/lib/learner/glosses";
import { abilitiesFor, recomputeAllAbilities } from "@/src/lib/learner/profile";
import { knownProbabilities } from "@/src/lib/learner/reading";
import { coverageOf } from "@/src/lib/learner/coverage";
import { createPlacementSession, submitPlacement } from "@/src/lib/learner/placement-service";
import { generateOne, importParagraph } from "@/src/scripts/generate/generate";
import { onDemandBrief } from "@/src/scripts/generate/briefs";
import { deepseekProvider } from "@/src/scripts/generate/provider";
import { loadEnv } from "@/src/scripts/env";
import { levelFromDifficulty } from "@/src/lib/difficulty";
import { AbilityState } from "@/src/models/AbilityState";
import type { CefrLevel } from "@/src/lib/lang";

const env = loadEnv();
import { wordSpans, TOKENIZER_VERSION } from "@/src/lib/tokenize";

type Variables = { user: ResolvedUser };

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

// ── Learner ───────────────────────────────────────────────────────────────────

app.get("/me", async (c) => {
  const user = c.get("user");
  const track = trackOf(user);
  // Ability is derived from the event log, so it is read rather than stored on the user document.
  const ability = await abilitiesFor(user.userId);
  return c.json({ ...user, ...track, tracks: Object.values(TRACKS), ability });
});

app.patch("/me/track", async (c) => {
  const body = (await c.req.json()) as { track?: unknown };
  if (!isTrackId(body.track)) {
    return c.json({ error: "unknown track", allowed: Object.keys(TRACKS) }, 400);
  }
  const user = c.get("user");
  const updated = await setTrack(user.userId, body.track);
  // Must include `tracks`, exactly like GET /me: the client uses this response to decide which
  // target language to load. Omitting it left the UI on the previous track's content.
  return c.json({ ...updated, ...trackOf(updated), tracks: Object.values(TRACKS) });
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
  // Follow the content's language, not the learner's stored track.
  const glossLang = glossLangFor(targetLang);

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
    // Compound parts are not tokens, so they are not in the lexicon map — but their glosses are
    // what makes a compound understandable. Add them to the keys so both lookups cover them.
    const partKeys = spans.flatMap((span) => span.compoundParts ?? []);
    const keys = [...new Set([...lexicon.keys(), ...partKeys])];
    const words = keys.length
      ? await Word.find({ targetLang, lemmaKey: { $in: keys } })
          .select("lemmaKey lemma pos level levelEstimated difficulty frequency article plural cognateWithEn falseFriend")
          .lean()
      : [];

    // This learner's own state, which lives in WordState rather than on the shared Word.
    const states = await statesFor(user.userId, targetLang, keys);
    // Translations from their own collection, grouped by lemma so EVERY reading is available.
    //
    // A token in running text carries no part of speech — nothing tells us "well-trained" is a
    // verb — so picking one reading by database order glossed a verb with the noun's 火车. All the
    // readings are returned, labelled, and the interface shows them together.
    const glosses = await glossesByLemma(targetLang, glossLang, keys);

    // Per-word knowledge probability, and the coverage it implies. Derived from the event log and
    // the ability estimate; nothing is written.
    //
    // Compound parts are supplied so a word that is not itself an entry is scored by what it is
    // made of; the parts are already in `keys`, so this costs no extra query.
    const compoundParts = new Map<string, string[]>();
    for (const span of spans) {
      if (span.compoundParts?.length) compoundParts.set(span.lemmaKey, span.compoundParts);
    }
    const known = await knownProbabilities(user.userId, targetLang, keys, {
      parts: compoundParts,
    });
    const probabilities = known.probabilities;

    const vocabulary: Record<string, unknown> = {};
    for (const word of words) {
      if (vocabulary[word.lemmaKey]) continue;
      const meanings = glosses.get(word.lemmaKey) ?? [];
      // The entry's own part of speech decides which reading leads, when it has one.
      const gloss =
        meanings.find((m) => m.pos && m.pos === word.pos) ?? meanings[0] ?? null;
      const state = states.get(word.lemmaKey);
      vocabulary[word.lemmaKey] = {
        lemma: word.lemma,
        pos: word.pos,
        gloss: gloss?.text ?? null,
        glossGenerated: gloss?.generated ?? null,
        glossSource: gloss?.source ?? null,
        // Estimated part of speech of the translation, so a word with several readings shows
        // which one is which rather than hiding them behind one unlabelled line.
        glossTermPos: gloss?.termPos ?? null,
        glossPos: gloss?.pos ?? null,
        meanings: meanings.map((m) => ({
          pos: m.pos || null,
          termPos: m.termPos ?? null,
          text: m.text,
          source: m.source,
        })),
        level: word.level,
        levelEstimated: word.levelEstimated,
        difficulty: word.difficulty,
        frequency: word.frequency,
        article: word.article ?? null,
        plural: word.plural ?? null,
        cognateWithEn: word.cognateWithEn ?? false,
        falseFriend: word.falseFriend ?? false,
        status: state?.status ?? "unfamiliar",
        timesMet: state?.timesMet ?? 0,
        unfamiliarity: state?.unfamiliarity ?? 0,
        lookupCount: state?.lookupCount ?? 0,
        exposureCount: state?.exposureCount ?? 0,
        // Probability this learner knows this word right now. The status above is a label derived
        // from counters; this is the quantity the reading verdict is actually computed from.
        pKnown: probabilities.get(word.lemmaKey) ?? null,
      };
    }

    // i+1 as a measurement rather than a level index: "you know 96% of this" is checkable, and it
    // means the same thing in every language.
    const coverage = {
      ...coverageOf(
        spans.map((span) => ({ lemmaKey: span.lemmaKey, kind: span.kind })),
        (lemmaKey) => probabilities.get(lemmaKey) ?? 0,
      ),
      // Whether the ability behind this number was measured at all. Without it the interface would
      // present a prediction from the default ability as though the learner had been assessed.
      measured: (known.ability?.n ?? 0) > 0,
      basis: known.ability,
    };

    out.push({
      ...paragraph,
      spans,
      marked,
      vocabulary,
      coverage,
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

/** This learner's words in a given state — driven by WordState, never by a field on Word. */
app.get("/words", async (c) => {
  const user = c.get("user");
  const targetLang = targetLangFor(c);
  const status = c.req.query("status") || "unfamiliar";

  const states = await WordState.find({ userId: user.userId, targetLang, status })
    .sort({ unfamiliarity: -1 })
    .limit(500)
    .lean();
  if (states.length === 0) return c.json([]);

  const words = await Word.find({
    targetLang,
    lemmaKey: { $in: states.map((s) => s.lemmaKey) },
  }).lean();
  const byKey = new Map(words.map((w) => [w.lemmaKey, w]));

  return c.json(
    states
      .map((state) => {
        const word = byKey.get(state.lemmaKey);
        return word ? { ...word, state } : null;
      })
      .filter(Boolean),
  );
});

app.get("/words/:lemmaKey", async (c) => {
  const user = c.get("user");
  const targetLang = targetLangFor(c);
  const lemmaKey = c.req.param("lemmaKey").toLowerCase();

  const word = await Word.findOne({ targetLang, lemmaKey }).lean();
  if (!word) return c.json({ error: "Not found" }, 404);

  const states = await statesFor(user.userId, targetLang, [lemmaKey]);
  const glosses = await allGlossesFor(targetLang, lemmaKey);
  return c.json({ ...word, state: states.get(lemmaKey) ?? null, glosses });
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

  // Resolve to an existing entry rather than upserting blindly. Identity is
  // (targetLang, lemma, pos), so a caller that does not know the part of speech would otherwise
  // create a *second* row for a word that is already in the vocabulary — fragmenting the entry,
  // losing its level and gloss, and splitting the learner's history across two documents.
  //
  // Preference order: the exact (lemma, pos) if the caller supplied one, otherwise any entry for
  // this lemma that already carries a part of speech, otherwise whatever exists.
  const candidates = await Word.find({ targetLang, lemmaKey }).limit(5);
  let word = pickExistingWord(candidates, pos);

  if (!word) {
    try {
      word = await Word.create({
        targetLang,
        lemmaKey,
        pos,
        lemma: body.lemma || body.surface || lemmaKey,
        frequency: {},
        level: null,
        levelEstimated: false,
        levelSource: null,
        difficulty: -1,
      });
    } catch (err) {
      // Lost a race with a concurrent mark for the same item; reuse the winner.
      const existing = await Word.findOne({ targetLang, lemmaKey, pos });
      if (!existing) throw err;
      word = existing;
    }
  }

  // `surfaceForms` is written by $addToSet alone — naming it in $setOnInsert too makes Mongo
  // reject the update with ConflictingUpdateOperators.
  if (body.surface) {
    await Word.updateOne({ _id: word._id }, { $addToSet: { surfaceForms: body.surface } });
  }

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
    { upsert: true, returnDocument: "after" },
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
  // Marking is evidence about ability, not only about this word. Recomputing here is what makes the
  // level stateful: the next paragraph is scored against this estimate, and without it the mark
  // changed the word but not the learner.
  const ability = await recomputeAllAbilities(user.userId);
  return c.json({ word, state, ability }, 201);
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
  // Un-marking retracts that evidence, so the estimate has to move back with it.
  const ability = await recomputeAllAbilities(user.userId);
  return c.json({ state, ability });
});

/** Batch vocabulary lookup, keyed by lemma (not by spelling — that is the point of lemmaKey). */
app.post("/words/batch", async (c) => {
  const body = (await c.req.json()) as { targetLang?: unknown; lemmaKeys?: string[]; words?: string[] };
  const targetLang = targetLangFor(c, body);
  const keys = (body.lemmaKeys ?? body.words ?? []).map((k) => k.toLowerCase());

  const words = await Word.find({ targetLang, lemmaKey: { $in: keys } })
    .select("lemma lemmaKey pos level levelEstimated difficulty article plural")
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
    // Exposures are the bulk of the evidence, so the estimate is refreshed here as well.
    const ability = await recomputeAllAbilities(user.userId);
    return c.json(
      { ok: true, appended: body.items.length, event: event?._id ?? null, ability },
      201,
    );
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
  // Both languages: an English event can change the prior German is using.
  const ability = await recomputeAllAbilities(user.userId);
  return c.json({ ok: true, event: event._id, state, ability }, 201);
});

// ── Generation ────────────────────────────────────────────────────────────────

/**
 * Write a new paragraph for the learner, on demand.
 *
 * The generator's acceptance test runs inside this call: the text is tokenized with the reader's own
 * tokenizer, measured against the reader's own thresholds, and judged for coherence before anything
 * is stored. A request that cannot produce an acceptable paragraph returns the reasons rather than
 * serving a bad one — which is the whole point of having a rubric.
 *
 * Slow on purpose: one to four model calls, so the client shows a spinner rather than expecting a
 * round trip.
 */
app.post("/paragraphs/generate", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { targetLang?: unknown; level?: unknown; topic?: unknown };
  const targetLang = targetLangFor(c, body);

  if (!env.DEEPSEEK_API_KEY) {
    return c.json(
      { error: "no generation provider configured", detail: "set DEEPSEEK_API_KEY in app/.env.local" },
      503,
    );
  }

  // The level comes from the learner's own estimate, so the text arrives pitched at them. Clamped to
  // the range the briefs cover: below A2 the vocabulary is too thin to build a scene, and above B2 a
  // generated text is not what this reader is for.
  const ability = await AbilityState.findOne({ userId: user.userId, targetLang }).select("theta").lean();
  const point = levelFromDifficulty(ability?.theta ?? 0.25);
  const level: CefrLevel = point === "B1" || point === "B2" ? point : "A2";
  const spec = {
    ...onDemandBrief(targetLang, level, typeof body.topic === "string" ? body.topic : undefined),
    // Unique, so every press adds a paragraph rather than replacing one. A drawn topic that happened
    // to match a curated brief used to overwrite that paragraph, and the button looked broken.
    briefId: `on-demand:${targetLang}:${Date.now().toString(36)}`,
  };

  try {
    const outcome = await generateOne(deepseekProvider(), spec);
    if (!outcome.passed) {
      return c.json(
        {
          error: "the generator could not produce an acceptable paragraph",
          topic: spec.topic,
          level,
          attempts: outcome.attempts,
          issues: outcome.issues,
        },
        502,
      );
    }

    const paragraphId = await importParagraph(outcome);
    return c.json(
      {
        ok: true,
        paragraphId,
        title: outcome.title,
        level,
        topic: spec.topic,
        words: outcome.content?.split(/\s+/).filter(Boolean).length ?? 0,
        coverage: outcome.coverage,
        attempts: outcome.attempts,
        modelCalls: outcome.providerCalls,
        reasoningTokens: outcome.reasoningTokens,
      },
      201,
    );
  } catch (error) {
    // A provider failure is the operator's to see, not a reason to serve something unmeasured.
    return c.json(
      { error: "generation failed", detail: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
      502,
    );
  }
});

// ── Placement test ────────────────────────────────────────────────────────────

/**
 * Serve a fresh placement test.
 *
 * A POST because it creates a session, and because a cached page must not hand out the same test
 * twice.
 */
app.post("/placement", async (c) => {
  const user = c.get("user");
  const targetLang = trackOf(user).targetLang;
  const session = await createPlacementSession(user.userId, targetLang);
  return c.json(session, 201);
});

/**
 * Score a submitted test and fold it into the ability estimate.
 *
 * The answers are checked against the stored session rather than trusted from the body, so the
 * pseudoword correction cannot be side-stepped by omitting items.
 */
app.post("/placement/submit", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as {
    sessionId?: unknown;
    responses?: unknown;
  };

  if (typeof body.sessionId !== "string") {
    return c.json({ error: "sessionId is required" }, 400);
  }
  if (!Array.isArray(body.responses)) {
    return c.json({ error: "responses must be an array" }, 400);
  }

  const responses = body.responses
    .filter(
      (entry): entry is { id: string; yes: boolean } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { yes?: unknown }).yes === "boolean",
    )
    .map((entry) => ({ id: entry.id, yes: entry.yes }));

  const result = await submitPlacement(user.userId, body.sessionId, responses);
  if (!result) return c.json({ error: "Not found" }, 404);

  // The placement is now evidence, so the estimate has to be refolded for both languages.
  const ability = await recomputeAllAbilities(user.userId);
  return c.json({ ok: true, result, ability }, 201);
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
