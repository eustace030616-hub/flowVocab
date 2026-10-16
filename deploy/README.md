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

## What was done, and how to do it again

```bash
# 1. Node 24 (Debian 13 ships 20, which has no `node:sqlite`)
TARBALL=$(curl -s https://nodejs.org/dist/latest-v24.x/ | grep -oE "node-v24\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz" | head -1)
curl -sLO "https://nodejs.org/dist/latest-v24.x/$TARBALL"
sudo mkdir -p /usr/local/lib/nodejs && sudo tar -xJf "$TARBALL" -C /usr/local/lib/nodejs
for b in node npm npx; do sudo ln -sf "/usr/local/lib/nodejs/${TARBALL%.tar.xz}/bin/$b" "/usr/local/bin/$b"; done

# 2. The app, its environment and its database (from the Mac)
rsync -az --exclude node_modules --exclude .next --exclude data --exclude .git --exclude archive \
      ./ berry:~/flowwing/app/
rsync -az .env.local berry:~/flowwing/app/.env.local
rsync -az data/flowwing.sqlite3 berry:~/flowwing/app/data/      # 244MB, ~55s

# 3. Build there — the Pi is arm64 with 4 cores and 2GB, and the build takes ~40s
ssh berry 'cd ~/flowwing/app && /usr/local/bin/npm ci && /usr/local/bin/npm run build'

# 4. Serve it, and publish it the way the other two are published
sudo systemctl enable --now flowwing
sudo tailscale serve --bg --http=3100 http://127.0.0.1:3100
```

## The unit

`/etc/systemd/system/flowwing.service`, modelled on `bookshelf.service`: same user, same
`After=network-online.target tailscaled.service`, same `Restart=always` / `RestartSec=2`, and
loopback-only for the same reason — `tailscale serve` is what faces the tailnet.

```ini
[Service]
User=eustace
Group=eustace
WorkingDirectory=/home/eustace/flowwing/app
ExecStart=/usr/local/bin/npm run start -- -H 127.0.0.1 -p 3100
Restart=always
RestartSec=2
```

## Maintaining it

```bash
deploy/deploy.sh          # sync source, install if the lockfile moved, build there, restart, verify
```

The Pi **builds its own copy**: it is arm64 and this Mac is not, so a build made here would not run
there. What travels is source. Three things are deliberately never touched, because they are state
rather than code — `data/flowwing.sqlite3` (the vocabulary and every mark the reader has made),
`.env.local` (the credential) and `node_modules` (platform-specific). A deploy that overwrote the
database would throw away the learner.

`npm ci` is skipped when `package-lock.json` is unchanged, which is most deploys: the build is
about 40 seconds on the Pi and the install is longer than that.

So the workflow is: edit on the Mac, run `deploy/deploy.sh`, and the change is live at
`http://berry:3100` about a minute later. Nothing needs to be copied by hand, and the database
stays where it is.

## Why a passage takes as long as it does

It is not the Pi. Every component was measured on both machines:

| | Mac | Pi |
|---|---|---|
| one writing call (≈400 tokens) | 3.7s | **3.3s** |
| tokenising 776 spans | 141ms | **116ms** |
| lexicon and glossary lookups | 22ms | **6ms** |
| DeepSeek round trip | — | **1.2s** |

The app's own work is a fifth of a second; the model is the rest. A generation makes one call for
topic vocabulary, one to four attempts at the passage, and three coherence samples — five to eleven
calls — so it takes between about six seconds and half a minute, and **which of those it is depends
on how many attempts the rubric and the judge reject, not on the host**. The 24.5s measured on the
Pi was a multi-attempt run; the 6s runs on the Mac were single-attempt ones.

What makes it feel instant is the stock: pressed while the buffer is full, the passage is already
written and the queue refills in the background afterwards.

## Two things that differ from the other projects

**Generation is slower there.** One passage took 24.5s on the Pi against 6-16s on the Mac — the
model calls are the same but the measuring and tokenising are not. That is inside the app's own
30-second deadline, but a run that needs a second attempt can reach it. The pregenerated stock is
what absorbs this: the route refills the buffer in the background after serving, which is verified
working on the Pi (a B2 passage appeared in the stock right after the first press).

**`npm run pregenerate` is a Mac-side script**, because `assertShippable` reads the licence rows
from MongoDB and there is no MongoDB on the Pi. The route's own background refill does not touch
it, so stocking works; only the bulk script would fail.

## How it is reached

Every project on `berry` is served directly on its own port and reached at `http://berry:<port>/`
— Timetable answers on 80 and 8000, Notes on 8080. Flowwing takes **3100**, which is what the
serve script already binds, so the address is:

    http://berry:3100

No reverse proxy and no path prefix, which is the point: a port per project is one less thing to
configure and one less thing to break.

## Development mode is not the way to serve it

`next dev` blocks its own client resources when the page is loaded from another origin, which
is exactly what a phone on the tailnet is — the page paints and nothing else works. That cost an
afternoon once. `npm run build && npm run serve` has no such rule, and recompiles nothing per
request, which is felt on a Pi.
