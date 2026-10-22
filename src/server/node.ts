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
import { onePullPass } from "../scripts/worker/pull";

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

// The pull loop, in the server rather than a separate unit: this process is already the Pi's service,
// and a timer here needs no new systemd file (installing one needs root). It is off unless
// FLOWWING_PULL is set, so a development server does not touch the shared database every minute.
if (process.env.FLOWWING_PULL === "1") {
  const intervalMs = Number(process.env.FLOWWING_PULL_INTERVAL_MS ?? 60_000);
  const tick = async () => {
    try {
      const result = await onePullPass();
      if (result.events > 0 || result.estimates > 0) {
        console.log(`pull: ${result.events} events · ${result.estimates} estimates`);
      }
    } catch (error) {
      // A sleeping network is not a crash: the cursor keeps its place and the next tick retries.
      console.warn(`pull paused: ${error instanceof Error ? error.message : error}`);
    }
  };
  setInterval(tick, intervalMs);
  void tick();
  console.log(`pull loop on, every ${Math.round(intervalMs / 1000)}s`);
}

serve({ fetch: outer.fetch, port, hostname }, (info) => {
  console.log(
    `flowwing on http://${hostname}:${info.port}` +
      ` · identity ${process.env.FLOWWING_IDENTITY_URL ? "deferred to Cloudflare" : "local"}`,
  );
});
