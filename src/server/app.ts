import { Hono } from "hono";
import type { StoreDriver } from "@/src/lib/store/driver";
import { isStarred, setStar, starredAmong } from "@/src/lib/store/stars";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  glossLangFor,
  isTargetLang,
  isTrackId,
  TRACKS,
  type TargetLang,
  type GlossLang,
  type TrackId,
} from "@/src/lib/lang";
import { verifyPassword } from "@/src/lib/learner/password";

import {
  SESSION_COOKIE,
  endSession,
  login,
  register,
  sessionUser,
} from "@/src/lib/learner/auth";
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
import { tokenizeWithLexicon, wordsForSpans } from "@/src/lib/learner/lexicon";
import { pickExistingWord } from "@/src/lib/learner/resolve";
import { allGlossesFor, glossesByLemma, pickGloss } from "@/src/lib/learner/glosses";
import { abilitiesFor, recomputeAllAbilities } from "@/src/lib/learner/profile";
import { knownProbabilities } from "@/src/lib/learner/reading";
import { coverageOf } from "@/src/lib/learner/coverage";
import { passageBand, targetBriefLevel, unknownWords } from "@/src/lib/learner/band";
import { levelFromDifficulty } from "@/src/lib/difficulty";
import {
  calibrationSummary,
  recentVotes,
  recordDifficultyVote,
  voteForParagraph,
} from "@/src/lib/store/calibration";
import { candidatesFor } from "@/src/lib/tokenize/rules";
import {
  addSurfaceForm,
  allProvenance,
  ensureWord,
  glossesByKeys,
  inflectionsByForm,
  wordsByKeys,
  wordsByLemma,
} from "@/src/lib/store/dictionary";
import {
  type ParagraphRecord,
  paragraphById,
  pruneUnmarked,
  legacyStarredIds,
  paragraphSummaries,
  paragraphsFor,
  POOL_TARGET_DEPTH,
  claimForReader,
  poolDepth,
  clearBuffered,
  upsertParagraphByBrief,
  countBuffered,
} from "@/src/lib/store/content";
import {
  abilitiesFor as abilitiesForStore,
  abilityFor,
  ensureUser,
  insertEvent,
  markCount,
  marksForParagraph,
  setMarkStatus,
  wordStatesByStatus,
  setUserTrack,
  upsertMark,
  countEvents,
} from "@/src/lib/store/learner";
import {
  answerPlacement,
  createPlacementSession,
  submitPlacement,
} from "@/src/lib/learner/placement-service";
import { generateOne, importParagraph } from "@/src/scripts/generate/generate";
import { onDemandBrief } from "@/src/scripts/generate/briefs";
import { refillBuffer } from "@/src/scripts/generate/pregenerate";
import { deepseekProvider } from "@/src/scripts/generate/provider";
import { loadEnv } from "@/src/scripts/env";
import type { CefrLevel } from "@/src/lib/lang";

const env = loadEnv();
import { wordSpans, TOKENIZER_VERSION } from "@/src/lib/tokenize";

type Variables = { user: ResolvedUser; username: string | null; store: StoreDriver };

/**
 * The API, as a function of where its rows live.
 *
 * No driver is imported here on purpose. The Node entry passes the SQLite file, the Worker passes a D1
 * binding, and neither drags the other's runtime into its bundle — which is what makes one module serve
 * both hosts for real rather than in principle.
 */
export function createApp(getStore: (env: unknown) => StoreDriver) {
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
/**
 * Who is asking, and whether they are allowed to.
 *
 * A session cookie is the identity. The old anonymous cookie still identifies a user who has not
 * registered yet — it is what their history is attached to — but it is no longer sufficient on its
 * own: without a session, everything except the auth routes answers 401, and the page shows the
 * gate. That keeps the first person's existing data without letting anyone in by looking like them.
 */
/**
 * Which store this request uses.
 *
 * The one thing that differs between the two deployments: a Worker has `env.DB` (D1) and no file, the
 * Node server has the file and no binding. Everything below this line is the same code either way.
 */
app.use("*", async (c, next) => {
  c.set("store", getStore(c.env));
  await next();
});

app.use("*", async (c, next) => {
  const session = await sessionUser(getCookie(c, SESSION_COOKIE), c.get("store"));
  // `resolveUser` returns `{ user, created }`; the identity is its `.user`.
  const legacyCookie = getCookie(c, USER_COOKIE);
  const legacy = session || !legacyCookie ? null : (await resolveUser(legacyCookie)).user;
  const user = session
    ? { userId: session.userId, track: session.track as TrackId }
    : (legacy ?? { userId: "", track: TRACKS["en-de"].id as TrackId });

  c.set("user", user);
  c.set("username", session?.username ?? null);

  // `c.req.path` carries the `/api` base path, so the comparison is made without it.
  const path = c.req.path.replace(/^\/api(?=\/|$)/, "");
  const open = path === "/auth" || path.startsWith("/auth/") || c.req.method === "OPTIONS";
  // The legacy cookie no longer admits anyone: it identifies the history a registration can claim,
  // not a way past the gate. Otherwise the first user never sees the form and can never register.
  if (!session && !open) {
    return c.json({ error: "sign in required", signedIn: false }, 401);
  }
  await next();
});

app.post("/auth/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const result = await register(String(body.username ?? ""), String(body.password ?? ""), getCookie(c, USER_COOKIE), c.get("store"));
  if (!result.ok) {
    return c.json({ error: result.error === "taken" ? "that name is taken" : "username and password are required" }, 409);
  }
  setCookie(c, SESSION_COOKIE, result.token, cookieOptions());
  return c.json({ ok: true, username: result.user.username }, 201);
});

app.post("/auth/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const result = await login(String(body.username ?? ""), String(body.password ?? ""), {
    store: c.get("store"),
    verifyLegacy: verifyPassword,
  });
  if (!result.ok) return c.json({ error: "wrong name or password" }, 401);
  setCookie(c, SESSION_COOKIE, result.token, cookieOptions());
  return c.json({ ok: true, username: result.user.username });
});

app.post("/auth/logout", async (c) => {
  await endSession(getCookie(c, SESSION_COOKIE), c.get("store"));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/auth/me", async (c) => {
  const session = await sessionUser(getCookie(c, SESSION_COOKIE), c.get("store"));
  return c.json({ signedIn: Boolean(session), username: session?.username ?? null });
});

/** One place for the cookie's flags, so a session cookie cannot drift from the others. */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    // Off by default: this app is served over plain HTTP behind `tailscale serve`, and a `secure`
    // cookie is not sent back over HTTP, so the session would silently fail to stick. Set
    // FLOWWING_SECURE_COOKIES=1 once it is behind real HTTPS.
    secure: process.env.FLOWWING_SECURE_COOKIES === "1",
  };
}

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
  const glossLang = glossLangFor(targetLang);

  const wantsSummary = c.req.query("summary") === "1";

  if (wantsSummary) {
    // The history list. Deliberately light: spans and vocabulary for every passage would grow without
    // bound as the reader generates more, and the list needs none of it.
    // The mark count per passage is a join, not a second query plus a fold in JavaScript.
    return c.json(paragraphSummaries(targetLang, user.userId));
  }

  const paragraphs = paragraphsFor(targetLang);

  const out = [];
  for (const paragraph of paragraphs) {
    out.push(await readerPayload(user.userId, paragraph, targetLang, glossLang, c.get("store")));
  }

  return c.json(out);
});

/**
 * Everything the reader needs for one paragraph: its spans, this learner's marks, the vocabulary
 * behind the spans, the translations, and the coverage the model implies.
 *
 * Shared by the list and the single-paragraph route, because the client now loads one passage at a
 * time from history — and two builders would eventually disagree about what the reader is given.
 */
async function readerPayload(
  userId: string,
  paragraph: ParagraphRecord,
  targetLang: TargetLang,
  glossLang: GlossLang,
  store: StoreDriver,
) {
  {
    const spans = await tokenizeWithLexicon(paragraph.content, targetLang);

    // Marks this learner has already made, keyed by where they made them.
    const marked = marksForParagraph(userId, String(paragraph._id));

    // Vocabulary records behind the spans, so the popover has a gloss without a second round trip.
    const lexicon = await wordsForSpans(targetLang, spans);
    // Compound parts are not tokens, so they are not in the lexicon map — but their glosses are
    // what makes a compound understandable. Add them to the keys so both lookups cover them.
    const partKeys = spans.flatMap((span) => span.compoundParts ?? []);
    const keys = [...new Set([...lexicon.keys(), ...partKeys])];
    // Every entry for the key, across parts of speech: the reader shows each reading it has.
    const words = keys.length ? wordsByKeys(targetLang, keys, { origin: null }) : [];

    // This learner's own state, which lives in WordState rather than on the shared Word.
    const states = await statesFor(userId, targetLang, keys);
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
    const known = await knownProbabilities(userId, targetLang, keys, {
      parts: compoundParts,
    });
    const probabilities = known.probabilities;

    // The count a reader can act on, next to the share they can read. Marked words count whatever
    // the model thinks; the rest are counted by prediction, which is what lets an unread passage be
    // graded at all.
    const markedLemmas = new Set(
      spans
        .filter((span) => span.kind === "word" && marked[`${span.start}`] === "marked")
        .map((span) => span.lemmaKey),
    );
    const unknown = unknownWords(spans, {
      pKnownOf: (key) => probabilities.get(key),
      isMarked: (key) => markedLemmas.has(key),
    });

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

    // An inflected surface can be an entry in its own right and still have no translation — DWDS lists
    // `eine`, `neue` and `gelebt` as headwords, and the English list holds `recycled` while CC-CEDICT
    // glosses only `recycle`. No dictionary glosses every form, so a form without a translation looks
    // for one in this order:
    //
    //   1. the stated base form, from the morphological data
    //   2. the rule-derived candidates the lemmatiser would produce, in its own order
    //
    // The headless check found this on twelve of the most common words in German, all of which showed
    // "No translation yet" while their base sat glossed in the database.
    const withoutGloss = Object.entries(vocabulary)
      .filter(([, entry]) => !(entry as { gloss?: string | null }).gloss)
      .map(([key]) => key);

    if (withoutGloss.length > 0) {
      const stated = inflectionsByForm(targetLang, withoutGloss);
      const baseOf = new Map(stated.map((row) => [row.form, row.baseLemmaKey]));

      // Preference order per key: stated base first, then the lemmatiser's candidates.
      const preference = new Map<string, string[]>();
      const wanted = new Set<string>();
      for (const key of withoutGloss) {
        const options = [
          baseOf.get(key),
          ...candidatesFor(key, targetLang),
        ].filter((c): c is string => typeof c === "string" && c.length > 0 && c !== key);
        preference.set(key, options);
        for (const option of options) wanted.add(option);
      }

      if (wanted.size > 0) {
        const borrowed = glossesByKeys(targetLang, glossLang, [...wanted]);
        const best = new Map<string, (typeof borrowed)[number]>();
        for (const row of borrowed) if (!best.has(row.lemmaKey)) best.set(row.lemmaKey, row);

        for (const [key, options] of preference) {
          const found = options.map((o) => best.get(o)).find((g) => g !== undefined);
          if (!found) continue;
          const entry = vocabulary[key] as Record<string, unknown>;
          entry.gloss = found.text;
          entry.glossSource = found.source;
          entry.glossTermPos = found.termPos ?? null;
          entry.glossVia = "inflection";
        }
      }
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

    return {
      ...paragraph,
      // Overrides the legacy column of the same name: a star belongs to a reader, and spreading the
      // row was what made one person's star visible to everybody.
      starred: await isStarred(userId, String(paragraph._id), store),
      spans,
      marked,
      vocabulary,
      // How many words are new to this reader, and the band that implies: the legible form of the
      // same judgement coverage makes as a percentage.
      // The reader's own verdict on this passage, if they have given one — so the control shows
      // their answer rather than the app's when they revisit it.
      difficultyVote: await voteForParagraph(userId, String(paragraph._id)),
      unknown: {
        count: unknown.count,
        band: passageBand(unknown.count),
        markedCount: unknown.markedCount,
        lemmas: unknown.lemmas,
      },
      coverage,
      tokenizerVersion: TOKENIZER_VERSION,
    };
  }
}

/**
 * One paragraph, in the shape the reader renders.
 *
 * The route used to return the raw document, which has no spans, no marks and no translations — so it
 * could not be used to open a passage. History needs exactly that, one passage at a time, without
 * loading every passage ever generated.
 */
app.get("/paragraphs/:id", async (c) => {
  const user = c.get("user");
  const paragraph = paragraphById(c.req.param("id"));
  if (!paragraph) return c.json({ error: "Not found" }, 404);
  const targetLang = (paragraph.targetLang ?? targetLangFor(c)) as TargetLang;
  return c.json(await readerPayload(user.userId, paragraph, targetLang, glossLangFor(targetLang), c.get("store")));
});

// ── Words ─────────────────────────────────────────────────────────────────────

/** This learner's words in a given state — driven by WordState, never by a field on Word. */
app.get("/words", async (c) => {
  const user = c.get("user");
  const targetLang = targetLangFor(c);
  const status = c.req.query("status") || "unfamiliar";

  const states = wordStatesByStatus(user.userId, targetLang, status, 500);
  if (states.length === 0) return c.json([]);

  const words = wordsByKeys(targetLang, states.map((state) => state.lemmaKey), { origin: null });
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

  const word = wordsByLemma(targetLang, lemmaKey)[0];
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
  const candidates = wordsByLemma(targetLang, lemmaKey);
  const existing = pickExistingWord(candidates, pos);
  let word = existing;

  if (!word) {
    // Insert-unless-present, which is the same race-safe shape the upsert had: a concurrent mark for
    // the same item finds the winner rather than creating a second row.
    word = ensureWord({
      targetLang,
      lemmaKey,
      pos,
      lemma: body.lemma || body.surface || lemmaKey,
      origin: "learner",
      surfaceForms: body.surface ? [body.surface] : [],
      level: null,
      levelEstimated: false,
      levelSource: null,
      difficulty: -1,
      frequency: {},
    });
  } else if (body.surface && !word.surfaceForms.includes(body.surface)) {
    addSurfaceForm(word._id, body.surface);
  }

  upsertMark({
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
  });

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
    setMarkStatus(user.userId, body.paragraphId, body.charStart, body.charEnd, "ignored");
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

  return c.json(wordsByKeys(targetLang, keys, { origin: null }));
});

/**
 * Star a passage, or unstar it.
 *
 * The one signal here about the *text* rather than about the words in it, and the only thing that
 * exempts a passage from being forgotten once it is old and unmarked.
 */
app.post("/paragraphs/:id/star", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { starred?: unknown };
  const id = c.req.param("id");
  const paragraph = paragraphById(id);
  if (!paragraph) return c.json({ error: "no such paragraph" }, 404);
  // A toggle is per reader now: "unstarred for me" is not a statement about anybody else.
  const starred = typeof body.starred === "boolean" ? body.starred : !(await isStarred(user.userId, id, c.get("store")));
  await setStar(user.userId, id, starred, c.get("store"));
  return c.json({ ok: true, starred });
});

/**
 * Record the reader's own verdict on how hard a passage was.
 *
 * A calibration control, not a feature: it stores their answer beside what the app computed and what
 * it believed about them at that moment, so the three can be compared afterwards. The computed side
 * is re-derived here rather than sent by the client, because the client's copy could be stale and the
 * point of the record is what the app actually said.
 */
app.post("/paragraphs/:id/difficulty", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { band?: unknown; explicit?: unknown };
  const id = c.req.param("id");
  const paragraph = paragraphById(id);
  if (!paragraph) return c.json({ error: "no such paragraph" }, 404);
  // No band means "the app's band, unchanged" — which is agreement, and the caller may omit it.
  const band = body.band === undefined ? null : String(body.band);
  if (band !== null && !["easy", "hard", "very_hard"].includes(band)) {
    return c.json({ error: "band must be easy, hard or very_hard" }, 400);
  }

  const payload = await readerPayload(user.userId, paragraph, paragraph.targetLang, glossLangFor(paragraph.targetLang), c.get("store"));
  const ability = abilityFor(user.userId, paragraph.targetLang);
  await recordDifficultyVote({
    userId: user.userId,
    targetLang: paragraph.targetLang,
    paragraphId: id,
    // Leaving the dropdown alone is an opinion too: it is agreement with what the app said.
    userBand: band ?? payload.unknown.band,
    explicit: body.explicit === true || (band !== null && band !== payload.unknown.band),
    computedBand: payload.unknown.band,
    unknownCount: payload.unknown.count,
    coverage: payload.coverage.coverage,
    theta: ability?.theta ?? 0.5,
    se: ability?.se ?? 1,
    n: ability?.n ?? 0,
    levelPoint: levelFromDifficulty(ability?.theta ?? 0.5) ?? "A1",
    levelLow: ability?.levelLow ?? "A1",
    levelHigh: ability?.levelHigh ?? "C2",
  });
  return c.json({ ok: true, summary: await calibrationSummary(user.userId) }, 201);
});

/** The three opinions, and how often they agree. The point of collecting them. */
app.get("/calibration", async (c) => {
  const user = c.get("user");
  return c.json({
    summary: await calibrationSummary(user.userId),
    votes: await recentVotes(user.userId, 50),
  });
});

// ── Marks ─────────────────────────────────────────────────────────────────────

/** Marks for one paragraph, keyed by charStart so the renderer can match them to spans. */
app.post("/marks/batch", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as { paragraphId?: string; targetLang?: unknown };
  if (!body.paragraphId) return c.json({ error: "paragraphId is required" }, 400);

  return c.json(marksForParagraph(user.userId, body.paragraphId));
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
      { ok: true, appended: body.items.length, event: event ?? null, ability },
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
  return c.json({ ok: true, event, state, ability }, 201);
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
  const ability = abilityFor(user.userId, targetLang);
  // One band above the estimate — see `targetBriefLevel` for why, and the measurement behind it.
  const level = targetBriefLevel(ability?.theta ?? 0.25);
  const spec = {
    ...onDemandBrief(targetLang, level, typeof body.topic === "string" ? body.topic : undefined),
    // Unique, so every press adds a paragraph rather than replacing one. A drawn topic that happened
    // to match a curated brief used to overwrite that paragraph, and the button looked broken.
    briefId: `on-demand:${targetLang}:${Date.now().toString(36)}`,
  };

  // A pregenerated passage is served immediately, and the stock is topped up afterwards without the
  // caller waiting for it. Generation is seconds rather than minutes now, but a request should still
  // never be the thing that waits.
  // Only stock written for the level this reader is at; anything else is written on demand.
  // Forget what is no longer worth keeping, before adding to it. Three conditions, all required:
  // old, unmarked and unstarred — see `pruneUnmarked`.
  pruneUnmarked(targetLang);

  // The order is the whole design: the pool first, generation only on a miss. A passage stays in
  // the pool after one reader takes it — it is claimed, not consumed — so depth is per reader.
  const buffered = claimForReader(user.userId, targetLang, level);
  if (buffered) {
    // Stock for this reader in the background if their view of the pool is shallow. The refill
    // itself is single-flight per level, so ten presses do not start ten loops.
    if (poolDepth(user.userId, targetLang, level) < POOL_TARGET_DEPTH) {
      void refillBuffer(user.userId, targetLang).catch(() => {});
    }
    void refillBuffer(user.userId, targetLang).catch(() => {
      // A failed top-up is not worth failing the request over; the next press will try again.
    });
    return c.json(
      {
        ok: true,
        paragraphId: buffered._id,
        title: buffered.title,
        level: buffered.level,
        topic: buffered.topic,
        words: buffered.wordCount,
        coverage: buffered.coverage,
        fromBuffer: true,
      },
      201,
    );
  }

  try {
    // Every press that misses the pool starts its own generation. There is no joining: the work is
    // an async call, several can be in flight at once, and ten readers pressing should get ten
    // passages rather than ten copies of one. What is shared is the *pool*, not the request.
    const outcome = await generateOne(deepseekProvider(), spec, {
      // A request that cannot be answered inside this is not worth holding open. With thinking
      // disabled a full generation takes a few seconds, so this is a backstop.
      deadlineMs: 30_000,
      skipTopicWords: false,
    });
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
/**
 * Answer one item.
 *
 * The reveal comes back only here, after the decision: a translation before the answer would make
 * this a reading test. The estimate comes back too, because the test has no length — the reader
 * decides when it has said enough, and needs to see what it is saying.
 */
app.post("/placement/answer", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as {
    targetLang?: unknown;
    sessionId?: string;
    itemId?: string;
    yes?: unknown;
  };
  const targetLang = targetLangFor(c, body);
  if (!body.sessionId || !body.itemId || typeof body.yes !== "boolean") {
    return c.json({ error: "sessionId, itemId and yes are required" }, 400);
  }

  const answer = await answerPlacement(user.userId, targetLang, body.sessionId, body.itemId, body.yes);
  if (!answer) return c.json({ error: "no such session or item" }, 404);
  return c.json({ ok: true, ...answer });
});

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
  const datasets = allProvenance();
  return c.json(datasets);
});

  return app;
}
