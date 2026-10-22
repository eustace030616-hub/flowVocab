/**
 * The Node entry: the same app the Worker runs, plus static files.
 *
 * This replaces `next start` on the Pi. The API is `src/server/app.ts` verbatim — the same module the
 * Worker imports — and the only additions are the built frontend and a listener. So "identical
 * flowwing on both hosts" is a property of the code rather than a maintenance promise.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app";
import { nodeDriver } from "../lib/store/driver-node";

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
  console.log(`flowwing on http://${hostname}:${info.port}`);
});
