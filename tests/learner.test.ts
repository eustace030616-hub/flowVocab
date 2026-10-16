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
import {
  difficultyFromZipf,
  fitZipfCalibration,
  levelFromDifficulty,
  levelMidpoint,
} from "../src/lib/difficulty";
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

/**
 * A stand-in for the database: a fixed vocabulary, plus any stated inflections.
 *
 * It only ever answers what it is asked, which is what makes it able to catch the class of bug the
 * real query had — assuming a candidate set is enough without asking.
 */
function memoryLexicon(...entries: string[]) {
  // A lemma may be given as "wort:pos" to declare a part of speech, which the tokenizer needs to
  // tell a verb from a noun.
  const pos = new Map<string, string[]>();
  for (const entry of entries) {
    const [lemma, declared] = entry.split(":");
    const key = lemma.toLowerCase();
    const list = pos.get(key) ?? [];
    if (declared && !list.includes(declared)) list.push(declared);
    pos.set(key, list);
  }

  const forms = new Map<string, string>();
  /** Stated (particle, verb) → merged, and form → parts, as the compiled tables supply them. */
  const separations = new Map<string, string>();
  const compounds = new Map<string, string[]>();
  let queries = 0;
  let maxQuery = 0;

  return {
    query: async (candidates: string[], surfaces: string[] = []) => {
      queries += 1;
      maxQuery = Math.max(maxQuery, candidates.length);
      // Mirrors the real query, which answers about surfaces as well as candidates: the tokenizer
      // asks whether a surface is itself a classified entry.
      const asked = [...new Set([...candidates, ...surfaces])];
      return {
        pos: new Map(
          asked.filter((c) => pos.has(c)).map((c) => [c, [...pos.get(c)!]] as [string, string[]]),
        ),
        forms: new Map(
          surfaces.filter((f) => forms.has(f)).map((f) => [f, forms.get(f)!] as [string, string]),
        ),
        // Stated morphology, when the fixture supplies it. An empty map is the signal to the
        // tokenizer that nothing has been compiled and the rules still apply.
        separations: new Map(
          [...separations.entries()].filter(([pair]) =>
            asked.some((word) => pair.startsWith(`${word}\u0000`)),
          ),
        ),
        compounds: new Map(
          [...compounds.entries()].filter(([form]) => asked.includes(form)),
        ),
      };
    },
    /** State that a surface is an inflection of a base, as Wiktionary does. */
    addForm: (form: string, base: string) => forms.set(form.toLowerCase(), base),
    /** State a separable verb, as Wiktionary's `auf.stehen` notation does. */
    addSeparation: (particle: string, verb: string, merged: string) =>
      separations.set(`${particle}\u0000${verb}`, merged),
    /** State a compound's parts, as the compiled table does. */
    addCompound: (form: string, parts: string[]) => compounds.set(form, parts),
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
  // One query is spent up front asking which surfaces are stated inflections; the rest are the
  // convergence passes. The point of the bound is that it does not grow with the text.
  assert.ok(queries <= 5, `should converge in a few passes, took ${queries}`);
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

// ── Frequency → difficulty calibration ────────────────────────────────────────

test("the curve is monotone: rarer words are never easier", () => {
  const calibration = fitZipfCalibration([
    { zipf: 6.5, level: "A1" }, { zipf: 6.1, level: "A1" },
    { zipf: 5.2, level: "A2" }, { zipf: 5.0, level: "A2" },
    { zipf: 4.2, level: "B1" }, { zipf: 4.4, level: "B1" },
    { zipf: 3.4, level: "B2" }, { zipf: 3.6, level: "B2" },
    { zipf: 2.6, level: "C1" }, { zipf: 2.8, level: "C1" },
    { zipf: 1.8, level: "C2" }, { zipf: 2.0, level: "C2" },
  ]);

  assert.equal(calibration.anchors.length, 6);

  // Anchors are ordered by zipf ASCENDING, which means difficulty DESCENDING.
  let previousZipf = Number.NEGATIVE_INFINITY;
  for (const anchor of calibration.anchors) {
    assert.ok(anchor.zipf >= previousZipf, "anchors must be sorted by ascending zipf");
    previousZipf = anchor.zipf;
  }

  // Difficulty must fall as frequency rises, at every step.
  const ascending = [...calibration.anchors].sort((a, b) => a.zipf - b.zipf);
  for (let i = 1; i < ascending.length; i += 1) {
    assert.ok(
      ascending[i].difficulty < ascending[i - 1].difficulty,
      "more frequent must mean less difficult",
    );
  }
});

test("non-monotone labels are clamped, not trusted", () => {
  // CEFR-J (A1–B2) and Octanove (C1–C2) were built to different standards and disagree. If C1's
  // median came out *more* frequent than B2's, an unclamped fit would call rare words easy.
  const calibration = fitZipfCalibration([
    { zipf: 6.0, level: "A1" },
    { zipf: 5.0, level: "A2" },
    { zipf: 4.0, level: "B1" },
    { zipf: 3.0, level: "B2" },
    { zipf: 3.9, level: "C1" }, // inverted on purpose
    { zipf: 2.0, level: "C2" },
  ]);
  const b2 = calibration.anchors.find((a) => a.level === "B2")!;
  const c1 = calibration.anchors.find((a) => a.level === "C1")!;
  assert.ok(c1.zipf <= b2.zipf, "C1 must not be more frequent than B2 after clamping");
});

test("difficultyFromZipf interpolates and clamps instead of extrapolating", () => {
  const calibration = fitZipfCalibration([
    { zipf: 6.0, level: "A1" },
    { zipf: 3.0, level: "B2" },
  ]);

  // Between anchors: halfway in zipf is halfway in difficulty.
  const mid = difficultyFromZipf(4.5, calibration);
  const a1 = levelMidpoint("A1");
  const b2 = levelMidpoint("B2");
  assert.ok(Math.abs(mid - (a1 + b2) / 2) < 1e-9);

  // Beyond the calibrated range the nearest anchor holds — a word rarer than the rarest anchor
  // is not "more than C2".
  assert.equal(difficultyFromZipf(9.9, calibration), a1, "very frequent clamps to A1");
  assert.equal(difficultyFromZipf(0.5, calibration), b2, "very rare clamps to the rarest anchor");

  // wordfreq reports 0 for a word it has never seen; that is *unknown*, not "extremely rare".
  // Treating it as rare would silently promote unseen words to C2.
  assert.equal(difficultyFromZipf(0, calibration), -1, "no frequency evidence means no difficulty");
  assert.equal(difficultyFromZipf(-3, calibration), -1);
});

test("an estimated level comes back as the right band", () => {
  assert.equal(levelFromDifficulty(levelMidpoint("A1")), "A1");
  assert.equal(levelFromDifficulty(levelMidpoint("B2")), "B2");
  assert.equal(levelFromDifficulty(levelMidpoint("C2")), "C2");
  assert.equal(levelFromDifficulty(0.999), "C2");
  assert.equal(levelFromDifficulty(-1), null);
});

test("a stated inflection beats the suffix rules", () => {
  // "liest" is a form of "lesen" and the stem changes, so no suffix rule can reach it. It was
  // matching an unrelated noun entry instead ("Liest"), which is how a verb form ended up showing a
  // noun's headword with a form description as its meaning.
  const lex = memoryLexicon("lesen", "liest", "kurz", "Kurze");
  lex.addForm("liest", "lesen");
  lex.addForm("kurzen", "kurz");

  return tokenizeAgainst("sie liest und kurzen Text", "de", lex.query).then((spans) => {
    const liest = spans.find((s) => s.surface === "liest")!;
    assert.equal(liest.lemmaKey, "lesen", "the stated base wins over the same-spelled entry");

    const kurzen = spans.find((s) => s.surface === "kurzen")!;
    assert.equal(kurzen.lemmaKey, "kurz", "not the noun Kurze, which the rules preferred");
  });
});

test("an inflection is only honoured when its base is a real entry", () => {
  // A mapping must never resolve a word to something the glossary cannot gloss. The datastore query
  // enforces that by only returning bases it holds, so this asserts the tokenizer does not
  // second-guess it either: what the query returns is what is used.
  const lex = memoryLexicon("liest", "lesen");
  lex.addForm("liest", "lesen");
  return tokenizeAgainst("liest", "de", lex.query).then((spans) => {
    assert.equal(spans[0].lemmaKey, "lesen");
    assert.equal(spans[0].matched, true);
  });
});

test("a particle does not fuse with a non-verb", () => {
  // The bug this guards: "kurz" is a genuine separable prefix (kurzarbeiten), and "kurzen"
  // resolves to "kurz" via the inflection map — so the parser fused it with the next token,
  // "Text", into the real noun *Kurztext*. Separable attachment is a statement about verbs.
  const lex = memoryLexicon(
    "kurz:adjective",
    "text:noun",
    "kurztext:noun",
    "stehen:verb",
    "aufstehen:verb",
    "auf",
  );
  lex.addForm("kurzen", "kurz");

  return tokenizeAgainst("einen kurzen Text", "de", lex.query).then((spans) => {
    const text = spans.find((s) => s.surface === "Text")!;
    assert.equal(text.lemmaKey, "text", "the noun keeps its own lemma");
    assert.equal(text.detached, undefined, "no particle may attach to a noun");

    const kurzen = spans.find((s) => s.surface === "kurzen")!;
    assert.equal(kurzen.absorbedInto, undefined, "and the adjective is not absorbed");
  });
});

test("a genuine separable verb still attaches to its verb", async () => {
  // The guard must not cost the feature it protects: a real verb still takes its particle.
  const lex = memoryLexicon("stehen:verb", "aufstehen:verb", "auf", "sie");
  const spans = await tokenizeAgainst("sie steht auf", "de", lex.query);
  const verb = spans.find((s) => s.surface === "steht");
  assert.equal(verb?.lemmaKey, "aufstehen");
  assert.equal(verb?.detached?.length, 1);
});

test("a particle must end its clause", async () => {
  // "wächst eine Pflanze": the article "eine" follows the verb "wächst", and *einwachsen* is a real
  // separable verb — so adjacency and existence were both satisfied and the pair merged. Only the
  // placement rule separates them: a separated particle ends its clause, and "eine" has "Pflanze"
  // after it.
  const lex = memoryLexicon(
    "wachsen:verb",
    "einwachsen:verb",
    "ein:article",
    "pflanze:noun",
    "und",
  );
  const spans = await tokenizeAgainst("wächst eine Pflanze", "de", lex.query);

  assert.equal(spans.find((s) => s.surface === "wächst")?.lemmaKey, "wachsen");
  assert.equal(spans.find((s) => s.surface === "eine")?.absorbedInto, undefined);
  assert.equal(spans.find((s) => s.surface === "Pflanze")?.lemmaKey, "pflanze");
});

test("a clause-final particle still attaches, before punctuation or a conjunction", async () => {
  // Both ways a clause can end, since the rule keys on what follows the particle.
  const lex = memoryLexicon("stehen:verb", "aufstehen:verb", "auf", "sie", "und", "lesen:verb");

  const withConjunction = await tokenizeAgainst("sie steht früh auf und liest", "de", lex.query);
  assert.equal(withConjunction.find((s) => s.surface === "steht")?.lemmaKey, "aufstehen");

  const withFullStop = await tokenizeAgainst("sie steht früh auf.", "de", lex.query);
  assert.equal(withFullStop.find((s) => s.surface === "steht")?.lemmaKey, "aufstehen");
});

test("a word with its own part of speech outranks a stated inflection", () => {
  // "Pflanze" is a noun with its own entry; "pflanze" is also the first person of "pflanzen". The
  // form map alone lemmatised the plant into the verb.
  const lex = memoryLexicon("pflanze:noun", "pflanzen:verb");
  lex.addForm("pflanze", "pflanzen");

  return tokenizeAgainst("eine Pflanze", "de", lex.query).then((spans) => {
    assert.equal(spans.find((s) => s.surface === "Pflanze")?.lemmaKey, "pflanze");
  });
});

test("an unclassified same-spelling entry still defers to the stated inflection", async () => {
  // The other side of the rule, and the case it was written for: "liest" matches the noun *Liest*,
  // whose entry carries no part of speech, so the stated base must still win.
  const lex = memoryLexicon("liest", "lesen:verb");
  lex.addForm("liest", "lesen");

  const spans = await tokenizeAgainst("sie liest", "de", lex.query);
  assert.equal(spans.find((s) => s.surface === "liest")?.lemmaKey, "lesen");
});

test("a stated separation table replaces the proximity heuristic", async () => {
  // The heuristic's three failures all came from guessing with distance and word lists. With a table,
  // a pair the table does not list is not a pair — however close the words sit.
  const lex = memoryLexicon("stehen:verb", "aufstehen:verb", "setzen:verb", "gegenübersetzen:verb", "auf", "gegenüber");
  lex.addForm("steht", "stehen");
  lex.addForm("setzte", "setzen");
  lex.addSeparation("auf", "stehen", "aufstehen");
  // Deliberately NOT stating gegenüber + setzen: Wiktionary has it, but its merged verb has no
  // translation, so the compiler dropped it — and the merge must not happen.

  const spans = await tokenizeAgainst("sie steht auf und er setzte sich gegenüber", "de", lex.query);
  assert.equal(spans.find((s) => s.surface === "steht")?.lemmaKey, "aufstehen", "a stated pair merges");
  assert.equal(
    spans.find((s) => s.surface === "setzte")?.lemmaKey,
    "setzen",
    "an unstated pair does not, even though both words are known",
  );
});

test("without a compiled table the heuristic still runs", async () => {
  // A fresh clone has no tables; the app must still work, just less well.
  const lex = memoryLexicon("stehen:verb", "aufstehen:verb", "auf");
  const spans = await tokenizeAgainst("sie steht auf", "de", lex.query);
  assert.equal(spans.find((s) => s.surface === "steht")?.lemmaKey, "aufstehen");
});

test("a stated compound split replaces the lexicon splitter", async () => {
  // The compound itself is deliberately *not* in the lexicon: decomposition applies to words the
  // vocabulary does not hold, which is the only case where parts are the way in.
  const lex = memoryLexicon("wortschatz:noun", "aufbau:noun");
  lex.addCompound("wortschatzaufbau", ["wortschatz", "aufbau"]);
  const spans = await tokenizeAgainst("Der Wortschatzaufbau", "de", lex.query);
  const compound = spans.find((s) => s.surface === "Wortschatzaufbau")!;
  assert.deepEqual(compound.compoundParts, ["wortschatz", "aufbau"]);
});

test("a particle attaches inside its own clause, never across a full stop", async () => {
  // The reported bug. "Ich mache das Fenster auf. Sie kommt an mich." came back as *aufkommen*:
  // `auf` is clause-final, the host search ran forwards as well as backwards, and (auf, kommen) is a
  // real separable verb — so the particle reached past the period into the next sentence.
  const lex = memoryLexicon(
    "ich", "das", "fenster:noun", "sie", "mich",
    "machen:verb", "aufmachen:verb", "kommen:verb", "aufkommen:verb", "auf", "an",
  );
  lex.addForm("mache", "machen");
  lex.addForm("kommt", "kommen");
  lex.addSeparation("auf", "machen", "aufmachen");
  lex.addSeparation("auf", "kommen", "aufkommen");

  const spans = await tokenizeAgainst("Ich mache das Fenster auf. Sie kommt an mich.", "de", lex.query);
  assert.equal(
    spans.find((s) => s.surface === "mache")?.lemmaKey,
    "aufmachen",
    "the particle belongs to the verb in its own clause",
  );
  assert.equal(
    spans.find((s) => s.surface === "kommt")?.lemmaKey,
    "kommen",
    "and the next sentence's verb is untouched",
  );
  assert.equal(
    spans.find((s) => s.surface === "an")?.lemmaKey,
    "an",
    "`an mich` is a preposition, not a particle",
  );
});

test("the host may be a noun homograph, resolved by the particle's own base form", async () => {
  // `mache` is a DWDS noun headword ("die Mache"), so it keeps its own lemma and the stated
  // inflection `mache → machen` is the only thing that pairs with the particle. The particle's
  // presence is the evidence that resolves the homograph.
  const lex = memoryLexicon("machen:verb", "aufmachen:verb", "fenster:noun", "ich", "das", "auf");
  lex.addForm("mache", "machen");
  lex.addSeparation("auf", "machen", "aufmachen");

  const spans = await tokenizeAgainst("Ich mache das Fenster auf.", "de", lex.query);
  assert.equal(spans.find((s) => s.surface === "mache")?.lemmaKey, "aufmachen");
});

test("the compiled table decides what a particle is, not the hand-written list", async () => {
  // "zu" was missing from a hand-maintained set of 78 prefixes, so *zumachen* never merged. With a
  // compiled table present the list is not consulted at all.
  const lex = memoryLexicon(
    "die", "tür:noun", "und", "gehen:verb",
    "machen:verb", "zumachen:verb", "zu",
  );
  lex.addForm("macht", "machen");
  lex.addSeparation("zu", "machen", "zumachen");

  const spans = await tokenizeAgainst("Er macht die Tür zu und geht.", "de", lex.query);
  assert.equal(
    spans.find((s) => s.surface === "macht")?.lemmaKey,
    "zumachen",
    "a prefix the table knows is a prefix",
  );
});

test("a compiled table reaches every pass, not only the last one", async () => {
  // The wiring defect behind the reported bug: the tokenizer's pass loop built its options inline
  // with only lookup/posOf/resolveForm, so the tables never arrived and the heuristic made every
  // merge. This asserts the table is authoritative on the first pass, by stating a pair the
  // heuristic could also invent and requiring the table's answer.
  const lex = memoryLexicon("kommen:verb", "aufkommen:verb", "ankommen:verb", "auf", "an", "sie");
  lex.addForm("kommt", "kommen");
  lex.addSeparation("an", "kommen", "ankommen"); // stated
  lex.addSeparation("auf", "kommen", "aufkommen");

  const spans = await tokenizeAgainst("Sie kommt an.", "de", lex.query);
  assert.equal(spans.find((s) => s.surface === "kommt")?.lemmaKey, "ankommen");
});
