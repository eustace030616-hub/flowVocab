/**
 * The reader's API, as one module both hosts can run.
 *
 * It exists because the heavy part of reading is no longer a query: a passage is packed when it is
 * written (spans, glosses and each word's difficulty stored with it), so serving it needs one row for
 * the passage, one for this reader's marks, one for their word states, one for the estimate, and the
 * star and vote. Everything else — the probability a word is known, the unknown count, the band, the
 * coverage — is arithmetic on those rows.
 *
 * That is why this module can run anywhere: `getStore` is the only thing the host supplies, and no
 * dictionary, tokeniser or glossary is involved.
 *
 * Generation and the placement test stay on the Pi: they need the vocabulary to measure against, and
 * they are writer-side work rather than reading.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { SESSION_COOKIE, endSession, login, register, sessionUser } from "../lib/learner/auth";
import { probabilityKnown } from "../lib/learner/ability";
import { passageBand, unknownWords } from "../lib/learner/band";
import { coverageOf } from "../lib/learner/coverage";
import { levelFromDifficulty } from "../lib/difficulty";
import type { StoreDriver } from "../lib/store/driver";
import { setStore } from "../lib/store/registry";

export interface ReaderEnv {
  DB?: unknown;
}

type Variables = {
  userId: string;
  username: string | null;
  store: StoreDriver;
};

interface PackageRow {
  version: number;
}

export function createReaderApp(getStore: (env: unknown) => StoreDriver) {
  const app = new Hono<{ Variables: Variables }>().basePath("/api");

  app.use("*", async (c, next) => {
    const store = getStore(c.env);
    setStore(store);
    c.set("store", store);
    await next();
  });

  // ── Accounts ────────────────────────────────────────────────────────────────
  app.post("/auth/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const result = await register(String(body.username ?? ""), String(body.password ?? ""), undefined, c.get("store"));
    if (!result.ok) {
      return c.json({ error: result.error === "taken" ? "that name is taken" : "username and password are required" }, 409);
    }
    setCookie(c, SESSION_COOKIE, result.token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 86_400 });
    return c.json({ ok: true, username: result.user.username }, 201);
  });

  app.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const result = await login(String(body.username ?? ""), String(body.password ?? ""), { store: c.get("store") });
    if (!result.ok) return c.json({ error: "wrong name or password" }, 401);
    setCookie(c, SESSION_COOKIE, result.token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 86_400 });
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

  /**
   * Service endpoints, for the other host.
   *
   * Identity has one owner: this database. The Pi holds passages and generation, but it does not mint
   * its own accounts — it asks here, so a username resolves to one `userId` on both hosts and the two
   * cannot drift into "same name, different person".
   *
   * Guarded by a shared secret rather than a user session: the caller is a server, not a reader.
   */
  app.use("/service/*", async (c, next) => {
    const expected = (c.env as { SERVICE_SECRET?: string } | undefined)?.SERVICE_SECRET;
    const given = c.req.header("X-Flowwing-Service");
    if (!expected || given !== expected) return c.json({ error: "service access only" }, 403);
    await next();
  });

  app.post("/service/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const result = await register(String(body.username ?? ""), String(body.password ?? ""), undefined, c.get("store"));
    if (!result.ok) {
      return c.json({ error: result.error === "taken" ? "taken" : "missing" }, result.error === "taken" ? 409 : 400);
    }
    return c.json({ userId: result.user.userId, username: result.user.username, track: result.user.track }, 201);
  });

  app.post("/service/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const result = await login(String(body.username ?? ""), String(body.password ?? ""), { store: c.get("store") });
    if (!result.ok) return c.json({ error: "bad-credentials" }, 401);
    return c.json({ userId: result.user.userId, username: result.user.username, track: result.user.track });
  });

  /**
   * Accept a hash the Pi has just upgraded.
   *
   * Workers cannot run PBKDF2 above 100,000 iterations, so an account hashed at a higher count cannot
   * be verified here at all. The Pi can verify it (Node has no such cap), re-hashes at the portable
   * count and sends the result — which is why this endpoint exists, and why it is guarded by the
   * service secret rather than a password: the caller has already proved the password.
   */
  app.post("/service/password", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; passwordHash?: string };
    if (!body.username || !body.passwordHash) return c.json({ error: "username and passwordHash required" }, 400);
    await c.get("store").run(
      "UPDATE users SET passwordHash = ?, passwordSalt = NULL, updatedAt = ? WHERE username = ?",
      body.passwordHash,
      Date.now(),
      body.username,
    );
    return c.json({ ok: true });
  });

  /**
   * The pull side.
   *
   * The Pi cannot be called from here (it has no public endpoint), so it polls instead: it asks for
   * evidence that has arrived since it last looked, folds it with its own estimator — the only place
   * the full evidence model lives — and writes the resulting estimate back. Neither side depends on
   * the other being awake: reading works with the Pi asleep, and the Pi catches up when it wakes.
   *
   * The cursor is D1's `rowid`, which is monotonic and immune to clock skew or back-dated events.
   */
  app.get("/service/events", async (c) => {
    const since = Number(c.req.query("since") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 500), 1000);
    const rows = await c.get("store").all<Record<string, unknown>>(
      `SELECT rowid AS cursor, id, userId, targetLang, type, source, sessionId, paragraphId,
              wordId, surface, lemmaKey, charStart, charEnd, items, ts
         FROM events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
      since,
      limit,
    );
    return c.json({
      events: rows,
      cursor: rows.length ? Number(rows[rows.length - 1].cursor) : since,
      more: rows.length === limit,
    });
  });

  app.post("/service/ability", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: string;
      targetLang?: string;
      theta?: number;
      se?: number;
      n?: number;
      level?: string | null;
      levelLow?: string;
      levelHigh?: string;
      priorTheta?: number | null;
    };
    if (!body.userId || !body.targetLang || typeof body.theta !== "number") {
      return c.json({ error: "userId, targetLang and theta are required" }, 400);
    }
    await c.get("store").run(
      `INSERT INTO ability_states (id, userId, targetLang, theta, se, n, level, levelLow, levelHigh, priorTheta, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(userId, targetLang) DO UPDATE SET
         theta = excluded.theta, se = excluded.se, n = excluded.n, level = excluded.level,
         levelLow = excluded.levelLow, levelHigh = excluded.levelHigh,
         priorTheta = excluded.priorTheta, updatedAt = excluded.updatedAt`,
      `${body.userId}:${body.targetLang}`,
      body.userId,
      body.targetLang,
      body.theta,
      body.se ?? 1,
      body.n ?? 0,
      body.level ?? null,
      body.levelLow ?? "A1",
      body.levelHigh ?? "C2",
      body.priorTheta ?? null,
      Date.now(),
    );
    return c.json({ ok: true });
  });

  app.use("*", async (c, next) => {
    const session = await sessionUser(getCookie(c, SESSION_COOKIE), c.get("store"));
    if (!session) return c.json({ error: "sign in required", signedIn: false }, 401);
    c.set("userId", session.userId);
    c.set("username", session.username);
    await next();
  });

  // ── The learner ─────────────────────────────────────────────────────────────
  app.get("/me", async (c) => {
    const store = c.get("store");
    const user = await store.get<{ userId: string; track: string; uiLocale: string }>(
      "SELECT userId, track, uiLocale FROM users WHERE userId = ?",
      c.get("userId"),
    );
    const ability = await store.all<Record<string, unknown>>(
      "SELECT * FROM ability_states WHERE userId = ?",
      c.get("userId"),
    );
    const track = user?.track ?? "en-de";
    return c.json({
      userId: c.get("userId"),
      username: c.get("username"),
      track,
      targetLang: track === "zh-en" ? "en" : "de",
      glossLang: track === "zh-en" ? "zh" : "en",
      uiLocale: user?.uiLocale ?? "en",
      tracks: [
        { id: "en-de", targetLang: "de", glossLang: "en" },
        { id: "zh-en", targetLang: "en", glossLang: "zh" },
      ],
      ability: ability.map((row) => ({
        ...row,
        levelPoint: levelFromDifficulty(Number(row.theta ?? 0.5)),
      })),
    });
  });

  app.patch("/me/track", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { track?: string };
    await c.get("store").run(
      "UPDATE users SET track = ?, updatedAt = ? WHERE userId = ?",
      body.track ?? "en-de",
      Date.now(),
      c.get("userId"),
    );
    return c.json({ ok: true, track: body.track ?? "en-de" });
  });

  // ── The history list ────────────────────────────────────────────────────────
  app.get("/paragraphs", async (c) => {
    const store = c.get("store");
    const targetLang = c.req.query("targetLang") ?? "de";
    const rows = await store.all<Record<string, unknown>>(
      `SELECT p.id, p.title, p.topic, p.level, p.wordCount, p.source, p.createdAt, p.briefId,
              COALESCE(m.n, 0) AS markedCount,
              CASE WHEN s.paragraphId IS NULL THEN 0 ELSE 1 END AS starred
         FROM paragraphs p
         LEFT JOIN (SELECT paragraphId, COUNT(*) AS n FROM marks
                     WHERE userId = ? AND status = 'marked' GROUP BY paragraphId) m ON m.paragraphId = p.id
         LEFT JOIN paragraph_stars s ON s.paragraphId = p.id AND s.userId = ?
        WHERE p.targetLang = ?
        ORDER BY p.createdAt DESC`,
      c.get("userId"),
      c.get("userId"),
      targetLang,
    );
    return c.json(
      rows.map((row) => ({ ...row, _id: row.id, starred: Boolean(row.starred) })),
    );
  });

  // ── One passage ────────────────────────────────────────────────────────────
  app.get("/paragraphs/:id", async (c) => {
    const store = c.get("store");
    const userId = c.get("userId");
    const id = c.req.param("id");

    const paragraph = await store.get<{ id: string; targetLang: string; content: string; title: string; topic: string | null; level: string | null; wordCount: number }>(
      "SELECT id, targetLang, content, title, topic, level, wordCount FROM paragraphs WHERE id = ?",
      id,
    );
    if (!paragraph) return c.json({ error: "no such paragraph" }, 404);

    const pack = await store.get<PackageRow>("SELECT version FROM passage_packages WHERE paragraphId = ?", id);
    const chunks = pack
      ? await store.all<{ data: string }>(
          "SELECT data FROM package_chunks WHERE paragraphId = ? ORDER BY idx ASC",
          id,
        )
      : [];
    if (!pack || chunks.length === 0) {
      return c.json(
        { error: "this passage has not been packed", detail: "packing happens on the writer; the Pi packs every passage it stores" },
        409,
      );
    }
    const packed = JSON.parse(chunks.map((chunk) => chunk.data).join("")) as {
      spans: Array<{ kind: string; surface: string; lemmaKey: string; start: number; end: number }>;
      vocabulary: Record<string, { lemma: string; pos: string | null; gloss: string | null; difficulty: number }>;
    };

    const ability = await store.get<{ theta: number; se: number; n: number }>(
      "SELECT theta, se, n FROM ability_states WHERE userId = ? AND targetLang = ?",
      userId,
      paragraph.targetLang,
    );
    const theta = ability?.theta ?? 0.25;

    const markRows = await store.all<{ lemmaKey: string; status: string }>(
      "SELECT lemmaKey, status FROM marks WHERE userId = ? AND paragraphId = ?",
      userId,
      id,
    );
    const marked: Record<string, string> = {};
    for (const row of markRows) marked[row.lemmaKey] = row.status;

    const keyOf = (lemmaKey: string) => packed.vocabulary[lemmaKey];
    const probabilities = new Map<string, number>();
    for (const [lemmaKey, entry] of Object.entries(packed.vocabulary)) {
      if (entry.difficulty >= 0) probabilities.set(lemmaKey, probabilityKnown(theta, entry.difficulty));
    }

    const unknown = unknownWords(packed.spans as never, {
      pKnownOf: (key: string) => probabilities.get(key),
      marked: (span: { lemmaKey: string }) => marked[span.lemmaKey] === "marked",
    } as never);
    const coverage = coverageOf(
      packed.spans as never,
      (key: string) => probabilities.get(key) ?? 1,
    );

    const star = await store.get("SELECT 1 AS x FROM paragraph_stars WHERE userId = ? AND paragraphId = ?", userId, id);
    const vote = await store.get<{ userBand: string }>(
      "SELECT userBand FROM difficulty_votes WHERE userId = ? AND paragraphId = ? ORDER BY createdAt DESC LIMIT 1",
      userId,
      id,
    );

    return c.json({
      ...paragraph,
      _id: paragraph.id,
      starred: Boolean(star),
      difficultyVote: vote?.userBand ?? null,
      spans: packed.spans,
      marked,
      vocabulary: Object.fromEntries(
        Object.entries(packed.vocabulary).map(([key, entry]) => [
          key,
          { lemma: entry.lemma, pos: entry.pos, gloss: entry.gloss, glossGenerated: null, glossSource: null,
            glossTermPos: null, glossPos: null, meanings: entry.gloss ? [{ pos: null, termPos: null, text: entry.gloss, source: null }] : [] },
        ]),
      ),
      unknown: { count: unknown.count, band: passageBand(unknown.count) },
      coverage: { coverage: coverage.coverage, verdict: coverage.verdict, unknownIn: coverage.unknownIn },
      known: { measured: (ability?.n ?? 0) > 0, basis: ability ?? null },
      keyOf: undefined,
    });
  });

  app.get("/marks/batch", async (c) => c.json({}));

  // ── Writing: marks, stars, votes, evidence ─────────────────────────────────
  app.post("/paragraphs/:id/star", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { starred?: boolean };
    const existing = await store.get("SELECT 1 AS x FROM paragraph_stars WHERE userId = ? AND paragraphId = ?", c.get("userId"), id);
    const starred = typeof body.starred === "boolean" ? body.starred : !existing;
    if (starred) {
      await store.run(
        "INSERT INTO paragraph_stars (userId, paragraphId, createdAt) VALUES (?,?,?) ON CONFLICT DO NOTHING",
        c.get("userId"), id, Date.now(),
      );
    } else {
      await store.run("DELETE FROM paragraph_stars WHERE userId = ? AND paragraphId = ?", c.get("userId"), id);
    }
    return c.json({ ok: true, starred });
  });

  app.post("/paragraphs/:id/difficulty", async (c) => {
    const store = c.get("store");
    const body = (await c.req.json().catch(() => ({}))) as { band?: string; explicit?: boolean };
    const band = body.band ?? "hard";
    await store.run(
      `INSERT INTO difficulty_votes (id, userId, targetLang, paragraphId, userBand, computedBand, unknownCount,
                                     coverage, theta, se, n, levelPoint, levelLow, levelHigh, explicit, createdAt)
       VALUES (?,?,?,?,?,?,0,-1,0.5,1,0,'A1','A1','C2',?,?)`,
      crypto.randomUUID(), c.get("userId"), "de", c.req.param("id"), band, band, body.explicit ? 1 : 0, Date.now(),
    );
    return c.json({ ok: true });
  });

  app.post("/events", async (c) => {
    const store = c.get("store");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // The evidence log, which is what the estimator folds — the mark row alone is the current state,
    // not the history of how it got there.
    await store.run(
      `INSERT INTO events (id, userId, targetLang, type, source, sessionId, paragraphId, wordId,
                           surface, lemmaKey, charStart, charEnd, items, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      crypto.randomUUID(),
      c.get("userId"),
      String(body.targetLang ?? "de"),
      String(body.type ?? "exposure"),
      "web",
      (body.sessionId as string | undefined) ?? null,
      String(body.paragraphId ?? ""),
      (body.wordId as string | undefined) ?? null,
      (body.surface as string | undefined) ?? null,
      (body.lemmaKey as string | undefined) ?? null,
      body.charStart === undefined ? null : Number(body.charStart),
      body.charEnd === undefined ? null : Number(body.charEnd),
      body.items === undefined ? null : JSON.stringify(body.items),
      Date.now(),
    );

    if (body.type === "mark" || body.type === "unmark" || body.type === "lookup") {
      await store.run(
        `INSERT INTO marks (id, userId, targetLang, paragraphId, wordId, surface, lemmaKey, charStart, charEnd,
                            tokenizerVersion, status, markedAt)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)
         ON CONFLICT(userId, paragraphId, charStart, charEnd) DO UPDATE SET status = excluded.status, markedAt = excluded.markedAt`,
        crypto.randomUUID(), c.get("userId"), String(body.targetLang ?? "de"), String(body.paragraphId ?? ""),
        String(body.wordId ?? ""), String(body.surface ?? ""), String(body.lemmaKey ?? ""),
        Number(body.charStart ?? 0), Number(body.charEnd ?? 0),
        body.type === "unmark" ? "unmarked" : body.type === "lookup" ? "lookup" : "marked",
        Date.now(),
      );
    }
    return c.json({ ok: true }, 201);
  });

  app.post("/marks/batch", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { paragraphId?: string };
    const rows = await c.get("store").all<{ lemmaKey: string; status: string }>(
      "SELECT lemmaKey, status FROM marks WHERE userId = ? AND paragraphId = ?",
      c.get("userId"),
      body.paragraphId ?? "",
    );
    const out: Record<string, string> = {};
    for (const row of rows) out[row.lemmaKey] = row.status;
    return c.json(out);
  });

  // Writer-side and measurement features stay where the dictionary is.
  app.all("/paragraphs/generate", (c) =>
    c.json({ error: "generation runs on the Pi", detail: "it needs the vocabulary to measure against; this host has no dictionary" }, 501),
  );
  app.all("/placement", (c) => c.json({ error: "the placement test runs on the Pi" }, 501));
  app.all("*", (c) => c.json({ error: "not part of the reader API", route: c.req.path }, 501));

  return app;
}
