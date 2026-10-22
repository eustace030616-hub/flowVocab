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

import { d1Driver } from "./d1";

interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: (origin) => origin, credentials: true }));

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
