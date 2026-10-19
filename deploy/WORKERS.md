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
