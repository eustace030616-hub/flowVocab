# Stage A: making the store asynchronous

The Worker cannot import the API yet, and the platform says why:

    Uncaught Error: No such module "node:sqlite".

Everything above the store is shared and portable. The store is the last thing still written against a
synchronous local file, and this is the plan for it — with the part that is easy to get wrong written
down first.

## The rule that matters

**Only functions that touch the database become async.** The first attempt converted every export of
every module above the store and made `fitAbility`, `probabilityKnown` and `difficultyAtProbability`
asynchronous — pure arithmetic used by the React client and the test suite. It produced 382 type errors
and converted the wrong things, because "this module is near the store" is not the same as "this
function reads the database".

So, per module: convert the functions whose bodies reach `all`/`get`/`run`/`transaction`, directly or
through another converted function. Leave pure functions alone, always.

## Where it stands

```
done      util.ts        pure helpers out of db.ts; newId on WebCrypto
          stars.ts       3 functions, no database imported
          calibration.ts 4 functions
          auth.ts        shared, driver supplied by the host
          dictionary.ts  11 of 33 functions (the rest are row converters)
left      content.ts     12 functions the API uses: passages, the pool, pruning
          learner.ts     13: users, marks, word states, events, ability, placement
          then the ten modules above them, then the API and the generation scripts
```

Both hosts are deployed and working from the last merged commit; the Pi serves everything, the Worker
serves the UI and auth and answers 501 with a reason elsewhere.

## Order of work

1. `content.ts` and `learner.ts` together — they call each other.
2. The upper layer, one module at a time, converting only what the compiler says is missing a store:
   `ability · state · reading · profile · placement-service · lexicon · glosses · resolve · user`.
3. `src/server/app.ts` — 26 call sites, each an `await` plus `c.get("store")`.
4. The scripts (`generate`, `pregenerate`, importers) — they pass `nodeDriver` explicitly.

## What automation got, and where it stops

Converting `content.ts` and `learner.ts` with a script, then fixing call sites from the compiler's own
messages, took the tree from **155 type errors to 18**:

```
  pass                                            errors
  stores converted (content 12, learner 13)          155
  enclosing functions converted from tsc output       69
  call sites fixed from tsc messages (await, arg)     18
```

Those last 18 are the reason this is not finished: the call-site fixer inserts text at the position the
compiler reports, and the compiler's position is sometimes not the position it means — `await if (…)`,
`, nodeDriver` pushed inside an `if (…)` condition, `await ...spread`. Eighteen syntax errors across ten
files, and the fix is to edit them by hand, not to re-run the script.

So the honest state: the store conversion is mechanical and proven; the last mile is judgement.

## The mechanical recipe

For a store module, a script can do most of it:

    async keyword  ·  trailing `store: StoreDriver` parameter  ·  `await store.all(…)` etc.
    declared return types wrapped in Promise<>  ·  transaction callbacks made async

For the layers above, no script can decide which functions are database-bound — that distinction is
the work, and it is why the earlier over-reach happened. `tsc` is the guide: every remaining error is
an `await` or a store argument, and the enclosing function is the one to convert.

## The design change that halves the work

Six attempts at call-site repair failed at the same point, and the reason is worth writing down: the
driver is **stateless** — a handle to one database, not a connection with per-request state. So it does
not have to be a parameter at all.

```ts
// src/lib/store/registry.ts
setStore(d1Bridge(env.DB))   // Workers: same binding every request, so a race sets the same value
setStore(nodeDriver)         // Node: once, at startup
store: StoreDriver = currentStore()   // the parameter remains, defaulted
```

With that, converted store functions keep working when called without a store, and **call sites only
need `await` — no argument insertion**. That matters because every one of the repairs that went wrong
was an argument inserted in the wrong place (`, store` after a closing paren, `, nodeDriver` inside an
`if` condition, a parameter list). Removing argument insertion removes most of the failure surface.

The explicit parameter stays: tests, scripts and a future second database pass their own.

## The last mile, precisely

```
  src/lib/learner/ability.ts           1 site   (await placed inside an expression)
  src/lib/learner/placement-service.ts 4
  src/lib/learner/profile.ts           3        (embedding: `...await placementObservations(...)`)
  src/lib/learner/reading.ts           1
  src/lib/learner/state.ts             2
  src/lib/learner/user.ts              1        (store argument landed in the `if (…)` condition)
  src/lib/store/content.ts             1        (array argument before a spread)
  src/scripts/generate/generate.ts     1
  src/scripts/generate/pregenerate.ts  1
  src/server/app.ts                    1
```

Each is one line: move the `await` to the call, put the store argument on the call rather than on the
enclosing `if`, or hoist `await` out of a spread. Then `tsc` is clean, the 212 tests say whether the
semantics survived, and the Worker can import `src/server/app.ts` — which is the whole point.

## What has actually been tried, and where it stops

Seven attempts. The result is not nothing: it establishes exactly which parts are mechanical and which
are not.

```
mechanical, reliable        the three store modules convert with the transformer:
                            async keyword, defaulted `store`, awaited primitives, transaction
                            callbacks made async, return types wrapped in Promise<>
                            → 0 errors inside the store modules, twice, after hand-fixing
                            the chained-return shapes below

unreliable, every time      the same eleven-ish sites, because the call's closing paren is not
                            where a regex thinks it is:

                              return await store.all<T>(…).map(fn)          → assign, then map
                              return Number(await store.get<T>(…)?.n ?? 0)  → assign, then read
                              const x = await store.get<T>(…)?.id           → assign, then read
                              await inside a non-async callback             → make the callback async
                              a required parameter after an optional one     → reorder, or default it

                            Each fix is a whole-statement rewrite. A patch that touches half of one
                            produces `return rows(toParagraph)` or `Number(…)` with an extra paren —
                            both of which compile-error *somewhere else*, which is what made the
                            error count jump 2 → 319 on the sixth attempt.
```

The domain layer above the store then needs only `await` on its calls (with the registry default), and
that part never got a clean run.

## Verified recipe (round 8)

The store layer reached **0 errors** with this sequence, which is worth keeping:

1. Add `src/lib/store/registry.ts` and default every store parameter:
   `store: StoreDriver = currentStore()`.
2. Run the transformer over `content`, `learner`, `dictionary` (async, awaited primitives,
   transaction callbacks made async, return types wrapped in `Promise<>`).
3. Rewrite **whole statements** for the seven residual shapes — there are 20 of them and they are
   listed in the commit history; a fragment patch produces `return rows(toParagraph)` and a
   `Number(…)` with an extra paren.
4. Result: `npm run typecheck` shows zero errors inside `src/lib/store/`.

Then the domain layer needs only awaits. The await-only fixer took 132 → 24 in two rounds; the 24 are
the familiar corruptions, and repairing those reached **1 error** before the last fix reopened a
cascade (166). That is where it stands: the store converts, the layer above is awaited mechanically,
and the tail is still hand work.

## Why this is worth finishing

Once it is done, `src/server/app.ts` is one module for both hosts, the two drivers are the only
difference between them, and the Worker stops answering 501. The alternative — a second, D1-specific
read path in the Worker — would duplicate every query, which is the thing this project has spent its
effort avoiding.
