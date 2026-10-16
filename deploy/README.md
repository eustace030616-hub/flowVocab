# Running Flowwing on `berry`

The Pi serves this app over the tailnet, the same way the other projects on it are served. What
follows is everything this app needs that the others do not.

## What it needs

| | |
|---|---|
| **Node 24** | the store uses the built-in `node:sqlite`, which Node ships from 22.5 and stabilised later. Node 20 will not start the app. |
| **The database** | `data/flowwing.sqlite3` — **233MB**, gitignored, and not reproducible from the repository. See below. |
| **Environment** | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_REASONING`, `DEEPSEEK_MAX_TOKENS` — in `.env.local`, which is also gitignored. |
| **Port** | 3100, bound to `0.0.0.0` so the tailnet can reach it. |

```bash
npm ci
npm run build
npm run serve        # next start -H 0.0.0.0 -p 3100
```

## The database is the whole app

`data/flowwing.sqlite3` holds 289,292 headwords, 218,351 glosses, 217,377 inflections, 3,195
separable verbs and 110,677 compounds. Without it the app starts and shows an empty reader.

It can be brought across with `rsync` over the tailnet, which is a copy of one file and needs
no Docker on the Pi:

```bash
rsync -av --progress data/flowwing.sqlite3 berry:~/flowwing/app/data/
```

The alternative is rebuilding it there, which needs MongoDB and Docker: run the import scripts
in order, then `npm run migrate:mongo-to-sqlite`. That path exists but it is a long one, and
the file is already built.

## Development mode is not the way to serve it

`next dev` blocks its own client resources when the page is loaded from another origin, which
is exactly what a phone on the tailnet is — the page paints and nothing else works. That cost an
afternoon once. `npm run build && npm run serve` has no such rule, and recompiles nothing per
request, which is felt on a Pi.
