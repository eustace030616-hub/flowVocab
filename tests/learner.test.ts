/**
 * Learner-model and seed-content tests.
 *
 * Two things are being defended here:
 *
 *   1. State is a pure fold over the event log, so it is order-independent and repairable.
 *      Un-marking a word no longer destroys the evidence that it was ever marked.
 *   2. The German seed content still tokenizes correctly — compounds, separable verbs,
 *      inseparable verbs and false friends — against the exact vocabulary the demo app seeds.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  countsFromEvents,
  deriveState,
  EMPTY_COUNTS,
  statusFor,
} from "../src/lib/learner/state";
import { appendOnlyGuard } from "../src/models/Event";
import { Event } from "../src/models/Event";
import { Mark } from "../src/models/Mark";
import { User } from "../src/models/User";
import { WordState } from "../src/models/WordState";
import { Word } from "../src/models/Word";
import { tokenize, wordSpans, coverage } from "../src/lib/tokenize/index";
import { tokenizeAgainst } from "../src/lib/learner/lexicon";
import { resolveLemma } from "../src/lib/tokenize/rules";
import { pickExistingWord } from "../src/lib/learner/resolve";
import type { Span } from "../src/lib/tokenize/index";
import {
  SEED_PARAGRAPHS,
  seedLexicon,
} from "../src/scripts/seed-data";

// ── Derived state ─────────────────────────────────────────────────────────────

test("deriveState is a fold: counts in, state out", () => {
  const state = deriveState({ ...EMPTY_COUNTS, marks: 2, unmarks: 0, lookups: 5, exposures: 40 });
  assert.equal(state.timesMet, 2);
  assert.equal(state.unfamiliarity, 2);
  assert.equal(state.lookupCount, 5);
  assert.equal(state.exposureCount, 40);
});

test("un-marking floors the counter but keeps the evidence in the log", () => {
  const marked = deriveState({ ...EMPTY_COUNTS, marks: 1 });
  assert.equal(marked.unfamiliarity, 1);

  // Under the old code this was a destructive decrement and the `mark` was gone forever.
  const unmarked = deriveState({ ...EMPTY_COUNTS, marks: 1, unmarks: 1 });
  assert.equal(unmarked.unfamiliarity, 0);
  assert.equal(unmarked.timesMet, 1, "the earlier mark is still visible in timesMet");

  // And re-marking restores exactly, because the fold sees the whole history.
  const remarked = deriveState({ ...EMPTY_COUNTS, marks: 2, unmarks: 1 });
  assert.equal(remarked.unfamiliarity, 1);
  assert.equal(remarked.timesMet, 2);
});

test("derivation is order-independent: only the multiset of events matters", () => {
  const forward = countsFromEvents([{ type: "mark" }, { type: "unmark" }, { type: "mark" }]);
  const backward = countsFromEvents([{ type: "mark" }, { type: "mark" }, { type: "unmark" }]);

  assert.deepEqual(deriveState(forward), deriveState(backward));
});

test("status: unfamiliar before any mark, learning once met repeatedly, known at zero", () => {
  assert.equal(statusFor(0, 0), "unfamiliar");
  assert.equal(statusFor(1, 1), "unfamiliar");
  assert.equal(statusFor(3, 1), "learning", "'learning' used to be a dead enum value");
  assert.equal(statusFor(1, 0), "known");
  assert.equal(statusFor(5, 0), "known");
});

test("countsFromEvents handles every event type, including not_sure", () => {
  const counts = countsFromEvents([
    { type: "exposure" },
    { type: "lookup" },
    { type: "lookup" },
    { type: "mark" },
    { type: "unmark" },
    { type: "confirmed" },
    { type: "not_sure" },
  ]);
  assert.deepEqual(counts, {
    marks: 1,
    unmarks: 1,
    lookups: 2,
    exposures: 1,
    confirmed: 1,
    notSure: 1,
  });
});

test("the event log is append-only, with an explicit migration escape hatch", () => {
  assert.throws(() => appendOnlyGuard(), /append-only/);
  assert.throws(() => appendOnlyGuard({}), /append-only/);
  // A migration may opt out, and only a migration.
  assert.doesNotThrow(() => appendOnlyGuard({ bypassAppendOnly: true }));
});

test("learner state is per learner: it lives on WordState, never on the shared Word", () => {
  // Regression guard for a real bug. Learner state was originally stored on `Word`, which is
  // shared reference data — so two learners overwrote each other's history, and /api/words
  // reported one learner's counters to another. `Word` must stay free of it.
  const shared = ["status", "timesMet", "unfamiliarity", "lookupCount", "exposureCount"];
  for (const path of shared) {
    assert.equal(
      Word.schema.path(path),
      undefined,
      `Word must not carry "${path}" — that is per-learner data and belongs on WordState`,
    );
    assert.ok(WordState.schema.path(path), `WordState should own "${path}"`);
  }
  assert.ok(WordState.schema.path("wordId"), "WordState points at the shared vocabulary entry");
});

test("learner-state collections share User.userId's type", () => {
  // User.userId is a server-issued uuid *string*, but Mark and Event originally declared their
  // userId as an ObjectId. Mongoose then tried to cast a uuid on every learner query and threw,
  // which surfaced as a 500 on /api/me and /api/paragraphs — the whole app rendered empty.
  const userType = User.schema.path("userId")?.instance;
  assert.equal(userType, "String", "User.userId is an opaque uuid string");

  for (const model of [Mark, Event, WordState]) {
    assert.equal(
      model.schema.path("userId")?.instance,
      userType,
      `${model.modelName}.userId must match User.userId — an ObjectId here breaks every query`,
    );
  }
});

// ── Seed content, tokenized against the seeded vocabulary ─────────────────────

function germanSpans(title: string): Span[] {
  const paragraph = SEED_PARAGRAPHS.find((p) => p.title === title);
  assert.ok(paragraph, `seed paragraph "${title}" should exist`);
  return tokenize(paragraph!.content, paragraph!.targetLang, {
    lookup: seedLexicon(paragraph!.targetLang),
  });
}

function word(spans: Span[], surface: string): Span {
  const found = spans.find((s) => s.surface === surface && s.kind === "word");
  assert.ok(found, `expected a word token "${surface}"`);
  return found!;
}

test("every seeded paragraph tokenizes losslessly", () => {
  for (const paragraph of SEED_PARAGRAPHS) {
    const spans = tokenize(paragraph.content, paragraph.targetLang, {
      lookup: seedLexicon(paragraph.targetLang),
    });
    assert.equal(
      spans.map((s) => s.surface).join(""),
      paragraph.content,
      `lossless tokenization for "${paragraph.title}"`,
    );
  }
});

test("German seed: the compound resolves into its parts", () => {
  const spans = germanSpans("Wortschatz aufbauen");
  const compound = word(spans, "Wortschatzaufbau");
  assert.deepEqual(compound.compoundParts, ["wortschatz", "aufbau"]);
});

test("German seed: the separable verb resolves to its infinitive, keeping the particle", () => {
  const spans = germanSpans("Wortschatz aufbauen");
  const verb = word(spans, "steht");
  assert.equal(verb.lemmaKey, "aufstehen");
  assert.equal(verb.matched, true);
  assert.equal(verb.detached?.length, 1, "'auf' should be attached to the verb");

  const particle = word(spans, "auf");
  assert.equal(particle.absorbedInto, verb.start, "the particle belongs to the verb's item");
});

test("German seed: an inseparable verb is never split apart", () => {
  const spans = germanSpans("Wortschatz aufbauen");
  const verb = word(spans, "versteht");
  assert.equal(verb.lemmaKey, "verstehen");
  assert.equal(verb.detached, undefined, "'ver-' must not be treated as a particle");
});

test("German seed: the false friend is its own item, not the English word", () => {
  const spans = germanSpans("Vorsicht, falsche Freunde");
  const gift = word(spans, "Gift");
  assert.equal(gift.lemmaKey, "gift");
  // Language is part of identity, so this cannot collide with English "gift".
  const englishGift = tokenize("a gift", "en", { lookup: seedLexicon("en") });
  assert.equal(englishGift[0].lang, "en");
  assert.notEqual(englishGift[0].lang, gift.lang);
});

test("coverage is computable per learner and excludes punctuation", () => {
  const spans = germanSpans("Im Büro");
  const units = wordSpans(spans);
  assert.ok(units.length > 10);

  const noneKnown = coverage(spans, () => false);
  assert.equal(noneKnown.coverage, 0);
  assert.equal(noneKnown.unknown, units.length);

  const target = word(spans, "Kollegen");
  const withoutOne = coverage(spans, (s) => s.start !== target.start);
  assert.equal(withoutOne.unknown, 1);
  assert.ok(withoutOne.coverage > 0.9, "one unknown token in a sentence is comfortable reading");
});

test("the German seed exercises every case the old model could not represent", () => {
  // A regression guard on the seed itself: if someone simplifies the demo content, the cases
  // above silently stop being covered.
  const all = SEED_PARAGRAPHS.filter((p) => p.targetLang === "de").flatMap((p) =>
    tokenize(p.content, "de", { lookup: seedLexicon("de") }),
  );

  assert.ok(all.some((s) => s.compoundParts), "at least one compound");
  assert.ok(all.some((s) => s.detached), "at least one separable verb");
  assert.ok(all.some((s) => s.lemmaKey === "verstehen"), "at least one inseparable verb");
  assert.ok(all.some((s) => s.lemmaKey === "gift"), "the false friend");
  assert.ok(all.some((s) => s.surface === "warm"), "the cognate");
});

// ── Two-pass lexing against a lexicon that only answers what it is asked ──────

/** A stand-in for the database: it knows a fixed vocabulary and nothing else. */
function memoryLexicon(...lemmas: string[]) {
  const known = new Set(lemmas.map((l) => l.toLowerCase()));
  let queries = 0;
  let maxQuery = 0;
  return {
    query: async (candidates: string[]) => {
      queries += 1;
      maxQuery = Math.max(maxQuery, candidates.length);
      return new Set(candidates.filter((c) => known.has(c)));
    },
    stats: () => ({ queries, maxQuery }),
  };
}

test("a compound resolves even though its parts are not candidates of the compound", async () => {
  // This is the bug the two-pass design exists to prevent. "Wortschatzaufbau" never generates
  // "wortschatz" as a candidate, so a single up-front query can never confirm the split.
  const { query } = memoryLexicon("wortschatz", "aufbau", "der");
  const spans = await tokenizeAgainst("Der Wortschatzaufbau", "de", query);

  const compound = spans.find((s) => s.surface === "Wortschatzaufbau");
  assert.ok(compound);
  assert.deepEqual(compound!.compoundParts, ["wortschatz", "aufbau"]);
});

test("a separable verb resolves even though its infinitive is not a candidate of the finite form", async () => {
  // "steht" generates "stehen", never "aufstehen".
  const { query } = memoryLexicon("aufstehen");
  const spans = await tokenizeAgainst("sie steht morgen auf", "de", query);

  const verb = spans.find((s) => s.surface === "steht");
  assert.equal(verb!.lemmaKey, "aufstehen");
  assert.equal(verb!.detached?.length, 1);
});

test("the lexicon query asks only about candidates the tokenizer actually wanted", async () => {
  const { query, stats } = memoryLexicon("aufstehen", "wortschatz", "aufbau");
  await tokenizeAgainst("Der Wortschatzaufbau steht auf.", "de", query);

  const { queries, maxQuery } = stats();
  assert.ok(queries <= 3, `should converge in a few passes, took ${queries}`);
  // Not the ~6,000 keys that enumerating every compound split and particle combination would need.
  assert.ok(maxQuery < 120, `candidate set should stay small, was ${maxQuery}`);
});

test("German finite verb forms prefer the infinitive over a homographic noun", () => {
  // "braucht" must not resolve to "Brauch" (custom) merely because that noun exists.
  const withBoth = (candidate: string) => ["brauch", "brauchen"].includes(candidate);
  const resolved = resolveLemma("braucht", "de", withBoth);
  assert.equal(resolved.lemmaKey, "brauchen");
  assert.equal(resolved.matched, true);
});

test("a mark attaches to the existing vocabulary entry instead of creating a duplicate", () => {
  // "aufstehen" is seeded as pos "verb". A caller that sends no part of speech must reuse it —
  // otherwise the vocabulary fragments and the learner's history splits across two documents.
  const seeded = [{ pos: "verb", lemma: "aufstehen" }];

  assert.deepEqual(pickExistingWord(seeded, ""), seeded[0], "no pos: reuse the classified entry");
  assert.deepEqual(pickExistingWord(seeded, "verb"), seeded[0], "exact pos: reuse");
  assert.deepEqual(pickExistingWord(seeded, "noun"), seeded[0], "wrong pos: still reuse, never fork");

  // Several readings of one lemma: honour the caller's part of speech when it matches.
  const both = [{ pos: "noun", lemma: "Bank" }, { pos: "verb", lemma: "banken" }];
  assert.equal(pickExistingWord(both, "verb")?.pos, "verb");
  assert.equal(pickExistingWord(both, "noun")?.pos, "noun");
  // An unclassified row must never win over a classified one.
  const mixed = [{ pos: "", lemma: "steht" }, { pos: "verb", lemma: "aufstehen" }];
  assert.equal(pickExistingWord(mixed, "")?.pos, "verb");

  assert.equal(pickExistingWord([], "verb"), null, "nothing to reuse means create");
});
