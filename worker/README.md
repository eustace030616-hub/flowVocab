# The Worker, stage 1 — auth page, then an empty generation page

What exists now and is verified locally with `wrangler dev --local`:

```
GET  /                       static shell (assets binding)
GET  /api/auth/me            200 {"signedIn":false}
GET  /api/me                 401 until signed in
POST /api/auth/register      201, session cookie sticks
GET  /api/paragraphs         [] — no passages exist on this side yet
POST /api/auth/logout        200, then /api/me is 401 again
GET  /api/health             {"ok":true,"runtime":"workers",…}
```

Passwords are PBKDF2-SHA256 (WebCrypto), not scrypt: Workers have no Node built-ins. The two hashes
are deliberately not interchangeable — a Pi account cannot log in here, and that is fine while the
two run side by side.

## To see it on a Worker URL

Needs your Cloudflare account, once:

```bash
cd app
npx wrangler login                                  # browser, once

cd worker
npx wrangler d1 create flowwing-api                 # copy the uuid it prints into wrangler.toml
npx wrangler d1 execute flowwing-api --remote --file=schema.sql
npx wrangler deploy                                 # prints https://flowwing-api.<you>.workers.dev
```

If `wrangler` fails with `Unknown argument: …/wrangler-dist/cli.js`, this machine's `node` is
Electron-as-Node; run it with `/opt/homebrew/bin/node ./node_modules/wrangler/bin/wrangler.js …`.

## Stage 2 — one backend, one frontend, two drivers

The answer to "same backend, different frontend" is that it does not need two frontends:

```
        static page (Next `output: "export"` or this shell)
                          │  fetch /api/*
        ┌─────────────────┴──────────────────┐
   Pi: Hono + node driver            Workers: Hono + D1 driver
        └──────── same routes, same SQL, same responses ────────┘
```

So the Pi and Cloudflare become the *same* service with a different store, and the frontend is a
build artefact both can serve. What stage 2 needs, in order:

1. the store's 7 modules made async (the driver seam already exists; `calibration.ts` is the pattern)
2. the analysis blob to carry each word's difficulty, so the reader never needs the 289k-row
   vocabulary table — that is what keeps D1 at learner data only
3. auth behind a runtime crypto adapter, so one module serves both hosts
4. the Pi's generation writes passages into D1 (via the D1 HTTP API) — or keeps them local and the
   Worker is read-only until that link exists
