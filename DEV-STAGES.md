# The stages of building a thing like this

A worked example, written from this project's own history rather than from theory. Every stage below
has an **exit test** — a yes/no question that says whether the stage is finished. A stage is not
finished because it feels finished; it is finished when its test passes.

The sequence is:

```
design the logic ──► build the UI ──► wire the AI ──► put it online ──► get users ──► collect data ──► improve
```

It is a good sequence. It is also, in the order written, not the order that works — see
[What is wrong with the sequence](#what-is-wrong-with-the-sequence) at the end.

---

## 1. Design the logic

The thing that makes the app more than a wrapper. Here: difficulty from word frequency, ability as a
Rasch estimate, a tokenizer that knows separable verbs.

**Exit test:** can you explain what the app *decides* in one paragraph, and is that decision
testable without a user interface?

This project's version: `probabilityKnown(θ, d)` is a logistic curve and `targetBriefLevel(θ)` is a
lookup — both testable in a unit test, both running before any UI existed. 212 tests grew from this
stage.

**The trap:** this stage is where months disappear. The logic is the part nobody can see, so it
feels like the only place with real engineering, and it is easy to keep polishing it. The rule is
one paragraph and one test file per decision, then move on.

## 2. Build the UI

The skin over the logic, on real data, ugly allowed.

**Exit test:** can a stranger do the app's one job without being told how, on a phone, without
reading?

This project's version: the reader — a passage, spans you can tap, a band label, a star. Three
rewrites happened here (a grid of words, one word at a time, then the two-beat answer → reveal →
next), and each was driven by using it rather than thinking about it.

**The trap:** designing for a desktop browser while the real surface is a phone held in one hand.
Every touch-target and type-size bug in this project came from that gap.

## 3. Wire the AI

The generation seam. A prompt, a provider, a budget, and — most importantly — **a check on what comes
back.**

**Exit test:** with the model key removed, does the app fail visibly and honestly? With it present,
does output that violates the app's premise get rejected rather than shown?

This project's version: `generateOne` writes, checks the rubric, has a judge sample three times, and
keeps problems as *issues* instead of silently discarding them. The first version passed
`"Ich habe kein Gerät für Schutz"` three times out of three, which is why the judge exists.

**The trap:** treating the model as a reliable function. It is a random process with a budget. Two
measured failures here: thinking mode on by default (80s per passage), and a prompt asking for 300
words *and* "3–6 sentences per paragraph" (35-word fragments).

## 4. Put it online

One machine, one port, one link you can send someone.

**Exit test:** does it work in a browser that is not on the machine it runs on? Not the same
machine, not the same network — another device.

This project's version: a production build behind `tailscale serve` on a Pi. Development mode failed
this test for an afternoon: it blocked its own client chunks from the tailnet origin, so the phone
painted a page with no working buttons. `curl` said 200 the whole time.

**The trap:** verifying with `curl`. The bug class lives in the browser, and the only defence is a
real device.

## 5. Get users

One person who is not you, using it for a week.

**Exit test:** has anyone whose opinion you cannot predict used it unprompted, and told you
something you did not already know?

This project's version: still here. The binding constraint turned out to be geography and
distribution, not the stack — the tailnet reachable from this network is not reachable from
everywhere.

**The trap:** building for the thousandth user before the first one. Collecting "more users" before
this stage is done is collecting a mailing list of people who will not come back.

## 6. Collect data

Consent, a delete path, and instrumentation that answers a question you already have.

**Exit test:** can you name the question each event answers, and can a user remove themselves
without asking you?

This project's version: the difficulty vote records three opinions of the same passage — computed
band, reader's verdict, and the ability estimate at that moment — and `GET /api/calibration` reports
where they disagree. Nothing identity-bearing is stored; the delete path is still to be built, and
until it exists the data collection is not finished.

**The trap:** retrofitting consent. It is not a UI chore added later; it is a legal position that
must exist before the first other person's first passage.

## 7. Improve

Act on the data, and say what you did.

**Exit test:** can you point at one change made *because* of user data, and did the users hear about
it?

This project's version: the model-prior weight was `1` with exposure `0.25`, which made
`(0.3 + 2)/3 = 0.77` — below the `0.80` known-threshold, so a word read ten times unmarked could
never be learned. A user reported "24 new words despite knowing them", and the numbers said why.

**The trap:** changing things without telling anyone. Feedback stops arriving when nothing visibly
happens.

---

## What is wrong with the sequence

Two things.

**The logic stage is the biggest risk, and it is first.** It is the only stage with no user in it,
so it can absorb unlimited time and return no signal. The correction is not to skip it — it is to
build it *thin*: one decision, one test, then a vertical slice that reaches a human being.

**The real loop is a slice, not a sequence.** This project's healthiest week was not
logic → UI → AI in order; it was: a passage on a phone, barely working, with a real model call, then
depth wherever the phone exposed something. Every stage above should be passable at 20% depth
before any stage is taken to 100%:

```
        thin slice ───────────────────────────────► real user
        │  logic (1 decision)   │  UI (1 screen)   │  AI (1 call)
        │  online (1 link)      │  data (1 event)  │  improve (1 change)
```

Then deepen in the order the *user* complains, which is never the order you planned.

**And the one thing that cannot be deferred:** consent and deletion. They are not depth, they are
the price of admission to stage 5.
