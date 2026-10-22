# Putting the app on Cloudflare Workers

Not a config change. The store is written against a synchronous local SQLite file, and a Worker has
neither a file nor a synchronous query. What follows is the plan, with the parts that are real work
marked as such.

## What fits, and what does not

The deployment is smaller than it first appears, because of one fact about the app:

```
  app/page.tsx        a client component — every byte of data arrives over /api
  app/api/…/route.ts  Hono, which runs on Workers already
  src/lib/store/      the 233MB SQLite file — the only thing that does not fit
```

So the shape is:

```
  Workers assets  ──►  the built page (static; no Next.js server at the edge)
  Hono on Workers ──►  the API, unchanged in routing and behaviour
  D1              ──►  the store, behind a driver seam
```

There is no `@opennextjs/cloudflare` in this plan. The page is client-rendered, so `next build`
with `output: "export"` produces static assets and the API is a Worker of its own. Running the whole
Next server on the edge would buy nothing and cost a migration.

## The seam

`src/lib/store/driver.ts` — four async primitives, and two implementations:

```
  StoreDriver                 all · get · run · transaction
    ├── driver-node.ts        the SQLite file (what runs today)
    └── driver-d1.ts          to be written: env.DB through the same four
```

The domain modules take a driver as their **last, defaulted** argument:

```ts
export async function calibrationSummary(userId: string, store: StoreDriver = nodeDriver)
```

Which means Node call sites only gain an `await` and a Worker passes its own — no second copy of any
query, and no branch anywhere on "which host am I".

## Stages

**A. Make the store async.** 89 exported functions across 6 modules; 9 files import them. Mechanical,
covered by 212 tests. One module is converted already (`calibration.ts`) as the pattern: driver
parameter last with a default, functions `async`, call sites `await`. The rest is the same edit
repeated. *Verifiable locally.*

**B. The D1 driver.** `driver-d1.ts` mapping the four primitives onto `env.DB.prepare().bind()`,
plus the schema as a migration applied with `wrangler d1 execute`. *Needs a Cloudflare account.*

**C. The Worker entry.** `export default { fetch }` around the existing Hono app, with the D1 binding
passed into the driver per request. `wrangler.toml` with an `assets` binding for the page and a
`d1_databases` binding for the data. *Needs a Cloudflare account.*

**D. Static export.** `output: "export"` in `next.config.ts`, the API route excluded from the export,
and the page's fetches pointed at the Worker's URL. *Verifiable locally.*

## How the Worker reaches the Pi's API today

The store is synchronous on the Pi, so the Worker cannot answer passages itself. It proxies `/api/*`
to the Pi and serves the same frontend build, which means: same app, same API, same accounts, and one
username that works on both addresses.

The origin is `PI_ORIGIN` in `worker/wrangler.toml`. It currently points at a **quick tunnel**, whose
URL changes whenever it restarts — so that value goes stale. Making it durable takes one command on
the Pi, once:

```bash
sudo tailscale set --operator=eustace     # lets you manage serve/funnel without sudo
tailscale funnel --bg 3100                # stable HTTPS at https://berry.taild3bc35.ts.net
```

Then `PI_ORIGIN = "https://berry.taild3bc35.ts.net"` and the tunnel process is no longer needed.
Funnel has to be allowed for the tailnet; if the command reports an ACL error, enable Funnel for this
node in the admin console first.

## What is already built and verified

`worker/` holds the second half of the deployment:

```
  worker/wrangler.toml    the D1 binding and the assets slot
  worker/schema.sql       the same schema, generated from SCHEMA_SQL (PRAGMA lines stripped)
  worker/src/d1.ts        the four driver primitives over env.DB
  worker/src/index.ts     Hono: /api/health and /api/pool, reading real tables
```

Verified locally with no Cloudflare account, `wrangler dev --local` against a local D1:

    GET /api/health  → {"ok":true,"runtime":"workers","paragraphs":1}
    GET /api/pool    → {"level":"B1","passages":[{"id":"p-d1-1",…}]}

So the driver, the schema and the routing are proven. What is *not* portable yet is the rest of the
store: 85 functions still call `node:sqlite` synchronously (stage A).

### Two tooling traps, both hit

**Wrangler does not run on this machine's `node`.** That binary is Electron-as-Node, and wrangler's
argument parser reads the script path as a user argument — every command fails with
`Unknown argument: …/wrangler-dist/cli.js`. Use `/opt/homebrew/bin/node` instead:

    /opt/homebrew/bin/node ../node_modules/wrangler/bin/wrangler.js d1 execute flowwing-api --local --file=schema.sql

**D1 refuses `PRAGMA`.** Applying the schema verbatim failed with `not authorized: SQLITE_AUTH`,
because the dump included `PRAGMA journal_mode` and `foreign_keys` from `openDatabase`. The D1 copy
of the schema has those lines stripped; D1 manages its own journal.

## Two things that will bite

**Query count, not CPU.** The reader payload makes a handful of queries and the tokenizer looks up
per unknown word. On a local file that is free; on D1 each is a hop and each counts against the
per-request subrequest limit. The tokenizer's per-word queries are the part to batch — that work is
worth doing anyway, and it is the same work whether the host is D1 or a Pi.

**The tokenizer's CPU.** Free-plan Workers allow 10ms per request; tokenising a 300-word passage
measured ~100ms on the Pi. Reading needs the paid plan ($5/month) or a different tokenising approach.

## What stays on Node

The importers and `npm run pregenerate` read MongoDB, files and 200MB of dictionaries. They are
offline tools, they stay offline, and nothing about Workers changes that.
