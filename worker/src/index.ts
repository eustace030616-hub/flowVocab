/**
 * The API on Workers, reading D1.
 *
 * This is the second half of the deployment in `deploy/WORKERS.md`: the page is static and served as
 * assets, the API is this Worker, and the store is D1 through the same driver seam the local app uses.
 *
 * What is here now is the proof rather than the product: the Worker boots, binds D1, and answers from
 * real tables. The remaining work is mechanical — the store functions are still written for a
 * synchronous local file (see `deploy/WORKERS.md`, stage A).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";

import { d1Driver, type D1Database } from "./d1";
import { SESSION_COOKIE, endSession, login, register, sessionUser } from "./auth";

interface Env {
  DB: D1Database;
  /** The static shell, served by the assets binding. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: (origin) => origin, credentials: true }));

/**
 * The gate, on Workers.
 *
 * Same contract as the Pi's: any name, any password; a session cookie is the identity; everything
 * except the auth routes answers 401 without one.
 */
function cookieFrom(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function withSession(response: Response, token: string): Response {
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86_400}`,
  );
  return response;
}

app.post("/api/auth/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const result = await register(d1Driver(c.env.DB), String(body.username ?? ""), String(body.password ?? ""));
  if (!result.ok) {
    return c.json({ error: result.error === "taken" ? "that name is taken" : "username and password are required" }, 409);
  }
  return withSession(c.json({ ok: true, username: result.user.username }, 201), result.token);
});

app.post("/api/auth/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const result = await login(d1Driver(c.env.DB), String(body.username ?? ""), String(body.password ?? ""));
  if (!result.ok) return c.json({ error: "wrong name or password" }, 401);
  return withSession(c.json({ ok: true, username: result.user.username }), result.token);
});

app.post("/api/auth/logout", async (c) => {
  await endSession(d1Driver(c.env.DB), cookieFrom(c.req.raw, SESSION_COOKIE));
  const response = c.json({ ok: true });
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  return response;
});

app.get("/api/auth/me", async (c) => {
  const session = await sessionUser(d1Driver(c.env.DB), cookieFrom(c.req.raw, SESSION_COOKIE));
  return c.json({ signedIn: Boolean(session), username: session?.username ?? null });
});

app.use("/api/*", async (c, next) => {
  const open = c.req.path.startsWith("/api/auth/") || c.req.method === "OPTIONS";
  const session = open ? null : await sessionUser(d1Driver(c.env.DB), cookieFrom(c.req.raw, SESSION_COOKIE));
  if (!open && !session) return c.json({ error: "sign in required", signedIn: false }, 401);
  await next();
});

/** What the page asks for on load. Empty in this stage: no passages exist yet. */
app.get("/api/me", async (c) => {
  const session = await sessionUser(d1Driver(c.env.DB), cookieFrom(c.req.raw, SESSION_COOKIE));
  if (!session) return c.json({ error: "sign in required" }, 401);
  return c.json({
    userId: session.userId,
    username: session.username,
    track: session.track,
    targetLang: "de",
    glossLang: "en",
    uiLocale: "en",
    tracks: [
      { id: "en-de", targetLang: "de", glossLang: "en" },
      { id: "zh-en", targetLang: "en", glossLang: "zh" },
    ],
    ability: [],
  });
});

app.get("/api/paragraphs", async (c) => c.json([]));

app.get("/api/health", async (c) => {
  const store = d1Driver(c.env.DB);
  const [words, glosses, paragraphs] = await Promise.all([
    store.get<{ n: number }>("SELECT COUNT(*) n FROM words"),
    store.get<{ n: number }>("SELECT COUNT(*) n FROM glosses"),
    store.get<{ n: number }>("SELECT COUNT(*) n FROM paragraphs"),
  ]);
  return c.json({
    ok: true,
    runtime: "workers",
    words: words?.n ?? 0,
    glosses: glosses?.n ?? 0,
    paragraphs: paragraphs?.n ?? 0,
  });
});

/** The pool, as the page will ask for it: what this reader has not read yet. */
app.get("/api/pool", async (c) => {
  const store = d1Driver(c.env.DB);
  const level = c.req.query("level") ?? "B1";
  const rows = await store.all<{ id: string; title: string; level: string }>(
    "SELECT id, title, level FROM paragraphs WHERE targetLang = ? AND buffered = 1 AND level = ? LIMIT 5",
    c.req.query("targetLang") ?? "de",
    level,
  );
  return c.json({ level, passages: rows });
});

export default app;
