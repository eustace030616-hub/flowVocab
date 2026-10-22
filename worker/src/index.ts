/**
 * The Worker entry.
 *
 * It hosts the reader API — the same module the Pi runs for reading — over D1, and serves the built
 * frontend from the assets binding. No proxy, no second implementation: a passage arrives packed (its
 * spans, glosses and difficulties stored with it when it was written), so reading it here needs the
 * same six small queries and the same arithmetic as it does on the Pi.
 *
 * Generation and the placement test stay on the Pi: both need the vocabulary to measure against, and
 * this host deliberately does not have it.
 */
import { d1Bridge, type D1Like } from "../../src/lib/store/driver-d1";
import { createReaderApp } from "../../src/server/reader-api";

interface Env {
  DB: D1Like;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const app = createReaderApp((env) => d1Bridge((env as Env).DB));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx as never);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  },
};
