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
import { spawn, type ChildProcess } from "node:child_process";

import { loadEnv } from "../scripts/env";
import { onePullPass } from "../scripts/worker/pull";
import { syncD1Pool } from "../scripts/worker/pool";
import { callService, serviceConfig } from "../scripts/worker/client";

// `.env.local` is read into a record for the generator, but the rest of the server reads
// `process.env` — including the identity service this host defers accounts to. Put the values where
// everything can see them.
for (const [key, value] of Object.entries(loadEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

/**
 * The SoMaJo sidecar, when asked for.
 *
 * A child of this process rather than its own unit: it exists to answer one question for the writer, and
 * a service that outlives its parent is how a stale tokeniser keeps answering after a deploy.
 */
let segmenter: ChildProcess | null = null;
if (process.env.FLOWWING_TOKENIZER === "somajo") {
  const python = process.env.FLOWWING_TOKENIZER_PYTHON ?? path.resolve(process.cwd(), "tools/venv/bin/python");
  const script = path.resolve(process.cwd(), "tools/tokenize/server.py");
  const port = process.env.FLOWWING_TOKENIZER_PORT ?? "3110";
  try {
    segmenter = spawn(python, [script, "--port", port], { stdio: ["ignore", "inherit", "inherit"] });
    // A spawn failure is an async `error` event, not a throw: unhandled, it takes the whole server down —
    // which is the opposite of "the segmenter is optional".
    segmenter.on("error", (error) => {
      console.warn(`tokeniser: sidecar unavailable (${error.message}); using the built-in segmenter`);
      segmenter = null;
    });
    segmenter.on("exit", (code) => {
      if (code !== 0 && code !== null) console.warn(`tokeniser: sidecar exited (${code}); built-in segmenter from now on`);
      segmenter = null;
    });
    console.log(`tokeniser: SoMaJo sidecar on 127.0.0.1:${port}`);
  } catch (error) {
    console.warn(`tokeniser: sidecar failed to start (${error instanceof Error ? error.message : error})`);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      segmenter?.kill();
      process.exit(0);
    });
  }
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
  const idlePullMs = Number(process.env.FLOWWING_PULL_INTERVAL_MS ?? 60_000);
  const busyPullMs = Number(process.env.FLOWWING_PULL_BUSY_MS ?? 15_000);
  const idlePoolMs = Number(process.env.FLOWWING_POOL_INTERVAL_MS ?? 30_000);
  const busyPoolMs = Number(process.env.FLOWWING_POOL_BUSY_MS ?? 10_000);

  // Presence is "a reader did something in the last minute". While somebody is on, both loops run at the
  // fast rate so a burst of Generate presses cannot outrun the pool; sixty seconds after the last action
  // they fall back, because an idle laptop should cost nothing.
  let present = false;
  let lastPull = 0;
  let lastPool = 0;
  let pulling = false;
  let pooling = false;

  const tick = async () => {
    let config;
    try {
      config = serviceConfig();
      const presence = await callService<{ active: number }>(config, "/presence");
      present = presence.active > 0;
    } catch (error) {
      // Unreachable authority: treat as idle rather than fast, and say so once.
      present = false;
      console.warn(`presence unknown: ${error instanceof Error ? error.message : error}`);
    }
    const now = Date.now();

    if (!pulling && now - lastPull >= (present ? busyPullMs : idlePullMs)) {
      pulling = true;
      lastPull = now;
      try {
        const result = await onePullPass();
        if (result.events || result.estimates || result.requested) {
          console.log(
            `pull: ${result.events}e ${result.estimates}a ${result.requested}r · ${present ? "present" : "idle"}`,
          );
        }
      } catch (error) {
        console.warn(`pull paused: ${error instanceof Error ? error.message : error}`);
      } finally {
        pulling = false;
      }
    }

    if (!pooling && now - lastPool >= (present ? busyPoolMs : idlePoolMs)) {
      pooling = true;
      lastPool = now;
      try {
        const result = await syncD1Pool();
        if (result.pushed > 0) {
          console.log(
            `pool: pushed ${result.pushed} · ${Object.entries(result.depth).map(([k, v]) => `${k}=${v}`).join(" ")} · ${present ? "present" : "idle"}`,
          );
        }
      } catch (error) {
        console.warn(`pool paused: ${error instanceof Error ? error.message : error}`);
      } finally {
        pooling = false;
      }
    }
  };

  setInterval(() => void tick(), 5_000);
  console.log(
    `scheduler on · pull ${Math.round(idlePullMs / 1000)}s idle / ${Math.round(busyPullMs / 1000)}s present` +
      ` · pool ${Math.round(idlePoolMs / 1000)}s idle / ${Math.round(busyPoolMs / 1000)}s present`,
  );
}

serve({ fetch: outer.fetch, port, hostname }, (info) => {
  console.log(
    `flowwing on http://${hostname}:${info.port}` +
      ` · identity ${process.env.FLOWWING_IDENTITY_URL ? "deferred to Cloudflare" : "local"}`,
  );
});
