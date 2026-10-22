/**
 * The Node entry: the Pi's server.
 *
 * The API is `src/server/app.ts` verbatim, the built frontend is served from `web/dist`, and nothing
 * else happens here — so the two hosts differ by their store, not by their behaviour.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app";
import { nodeDriver } from "../lib/store/driver-node";
import { loadEnv } from "../scripts/env";

// `.env.local` is read into a record for the generator, but the rest of the server reads
// `process.env` — including the identity service this host defers accounts to. Put the values where
// everything can see them.
for (const [key, value] of Object.entries(loadEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const app = createApp(() => nodeDriver);
const port = Number(process.env.PORT ?? 3100);
const hostname = process.env.HOST ?? "127.0.0.1";
const dist = path.resolve(process.cwd(), "web/dist");

// The app carries `basePath("/api")`, so it is mounted as-is and an outer app owns everything else.
// Without this the static middleware inherited the same base path and every file 404'd.
const outer = new Hono();
outer.route("/", app);
outer.use("/*", serveStatic({ root: "./web/dist" }));
outer.use("/*", async (c) => c.html(await readFile(path.join(dist, "index.html"), "utf8")));

serve({ fetch: outer.fetch, port, hostname }, (info) => {
  console.log(
    `flowwing on http://${hostname}:${info.port}` +
      ` · identity ${process.env.FLOWWING_IDENTITY_URL ? "deferred to Cloudflare" : "local"}`,
  );
});
