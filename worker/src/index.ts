/**
 * The Worker entry — the maximum sharing the store currently allows.
 *
 * It imports the *same* auth module and serves the *same* UI build as the Pi. It does not import
 * `src/server/app.ts`, and that is not a preference: the rest of the API still reaches `node:sqlite`
 * through the synchronous store, which the platform refuses at upload time (`No such module
 * "node:sqlite"`). Until that store is async, the honest shape is:
 *
 *     shared      the UI, the auth module, the password format, the driver seam
 *     not yet     passages, marks, events, placement, generation — 501 here, with a reason
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { SESSION_COOKIE, endSession, login, register, sessionUser } from "../../src/lib/learner/auth";
import { d1Bridge, type D1Like } from "../../src/lib/store/driver-d1";

interface Env {
  DB: D1Like;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /**
   * Where the real API lives, for the interim.
   *
   * The store is still synchronous on the Pi, so this host cannot serve passages itself. Proxying is
   * the honest interim: the frontend, the API and the accounts are the Pi's, and only the address the
   * browser talks to is Cloudflare's. It also means one account works on both URLs, because there is
   * one account table.
   */
  PI_ORIGIN?: string;
}

const app = new Hono<{ Bindings: Env }>().basePath("/api");
const store = (env: Env) => d1Bridge(env.DB);

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    // Off by default: served over plain HTTP in some setups, where a `secure` cookie is never sent back.
    secure: false,
  };
}

app.post("/auth/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const result = await register(String(body.username ?? ""), String(body.password ?? ""), undefined, store(c.env));
  if (!result.ok) {
    return c.json({ error: result.error === "taken" ? "that name is taken" : "username and password are required" }, 409);
  }
  setCookie(c, SESSION_COOKIE, result.token, cookieOptions());
  return c.json({ ok: true, username: result.user.username }, 201);
});

app.post("/auth/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const result = await login(String(body.username ?? ""), String(body.password ?? ""), { store: store(c.env) });
  if (!result.ok) return c.json({ error: "wrong name or password" }, 401);
  setCookie(c, SESSION_COOKIE, result.token, cookieOptions());
  return c.json({ ok: true, username: result.user.username });
});

app.post("/auth/logout", async (c) => {
  await endSession(getCookie(c, SESSION_COOKIE), store(c.env));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/auth/me", async (c) => {
  const session = await sessionUser(getCookie(c, SESSION_COOKIE), store(c.env));
  return c.json({ signedIn: Boolean(session), username: session?.username ?? null });
});

app.use("*", async (c, next) => {
  const session = await sessionUser(getCookie(c, SESSION_COOKIE), store(c.env));
  if (!session) return c.json({ error: "sign in required", signedIn: false }, 401);
  c.set("userId" as never, session.userId as never);
  await next();
});

app.get("/me", async (c) => {
  const session = (await sessionUser(getCookie(c, SESSION_COOKIE), store(c.env)))!;
  return c.json({
    userId: session.userId,
    username: session.username,
    track: session.track,
    targetLang: session.track === "zh-en" ? "en" : "de",
    glossLang: session.track === "zh-en" ? "zh" : "en",
    uiLocale: "en",
    tracks: [
      { id: "en-de", targetLang: "de", glossLang: "en" },
      { id: "zh-en", targetLang: "en", glossLang: "zh" },
    ],
    ability: [],
  });
});

app.patch("/me/track", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { track?: string };
  const session = (await sessionUser(getCookie(c, SESSION_COOKIE), store(c.env)))!;
  await store(c.env).run("UPDATE users SET track = ?, updatedAt = ? WHERE userId = ?", body.track ?? session.track, Date.now(), session.userId);
  return c.json({ ok: true, track: body.track ?? session.track });
});

// Everything below needs the synchronous store. Said plainly rather than failing obscurely.
app.all("*", (c) =>
  c.json(
    {
      error: "not available on this host yet",
      detail:
        "this route reads the local SQLite store; it moves to D1 when the store becomes async (deploy/WORKERS.md, stage A)",
      route: c.req.path,
    },
    501,
  ),
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // Interim: the Pi answers the API. The request goes out as it came in, so cookies, bodies and
      // methods are preserved, and the response (including Set-Cookie) is returned untouched.
      if (env.PI_ORIGIN) {
        const target = new URL(url.pathname + url.search, env.PI_ORIGIN);
        return fetch(new Request(target, request));
      }
      return app.fetch(request, env, ctx as never);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  },
};

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
