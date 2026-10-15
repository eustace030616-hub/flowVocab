/**
 * Tokenizer tests.
 *
 * These are the cases that the original `content.split(" ")` + array-index data model
 * could not represent. They are the reason spans replaced indices, so they are the tests
 * that must not silently rot.
 *
 * Run: npm run test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tokenize, wordSpans, coverage, TOKENIZER_VERSION } from "../src/lib/tokenize/index";
import { lemmaKeyOf, nfc, foldSearchKey } from "../src/lib/tokenize/normalize";
import { englishCandidates, germanCandidates } from "../src/lib/tokenize/rules";
import type { LemmaLookup, Span } from "../src/lib/tokenize/index";

function lexicon(...keys: string[]): LemmaLookup {
  const set = new Set(keys.map((k) => lemmaKeyOf(k)));
  return (candidate: string) => set.has(candidate);
}

/** Concatenating surfaces must reproduce the input exactly — the UI renders spans directly. */
function assertLossless(text: string, spans: Span[]) {
  assert.equal(spans.map((s) => s.surface).join(""), nfc(text));
  // spans are contiguous and non-overlapping
  let cursor = 0;
  for (const s of spans) {
    assert.equal(s.start, cursor, `gap or overlap before "${s.surface}"`);
    assert.equal(s.end - s.start, s.surface.length, `span length mismatch for "${s.surface}"`);
    cursor = s.end;
  }
  assert.equal(cursor, nfc(text).length);
}

function find(spans: Span[], surface: string): Span | undefined {
  return spans.find((s) => s.surface === surface && s.kind === "word");
}

test("tokenizer version is recorded so persisted spans can be invalidated", () => {
  assert.equal(typeof TOKENIZER_VERSION, "number");
  assert.ok(TOKENIZER_VERSION >= 1);
});

test("English: tokenization is lossless across punctuation and whitespace", () => {
  const text = "The dog ran, and it didn't stop! Really?";
  const spans = tokenize(text, "en");
  assertLossless(text, spans);
});

test("German: tokenization is lossless with umlauts and ß", () => {
  const text = "Der große Bär läuft über die Straße, weil er müde ist.";
  const spans = tokenize(text, "de");
  assertLossless(text, spans);
});

test("German: a compound stays one token but yields resolvable parts", () => {
  const lookup = lexicon("wortschatz", "aufbau", "arbeit", "zimmer");
  const spans = tokenize("Der Wortschatzaufbau ist wichtig.", "de", { lookup });
  const compound = find(spans, "Wortschatzaufbau");
  assert.ok(compound, "compound token should exist");
  assert.deepEqual(compound!.compoundParts, ["wortschatz", "aufbau"]);
});

test("German: a compound is NOT split without lexicon confirmation", () => {
  // Splitting on a guess invents a vocabulary item the learner never met.
  const spans = tokenize("Der Wortschatzaufbau ist wichtig.", "de", {
    lookup: lexicon("ist", "wichtig"),
  });
  const compound = find(spans, "Wortschatzaufbau");
  assert.equal(compound!.compoundParts, undefined);
});

test("German: a separable verb resolves to its infinitive and keeps the particle", () => {
  const lookup = lexicon("aufstehen", "morgen", "früh", "wortschatzaufbau");
  const text = "Der Wortschatzaufbau steht morgen früh auf.";
  const spans = tokenize(text, "de", { lookup });

  const verb = find(spans, "steht");
  assert.ok(verb, "verb token should exist");
  assert.equal(verb!.lemmaKey, "aufstehen", "verb should resolve to the merged infinitive");
  assert.equal(verb!.matched, true);

  assert.deepEqual(verb!.detached, [{ start: text.indexOf("auf."), end: text.indexOf("auf.") + 3 }]);

  const particle = find(spans, "auf");
  assert.equal(particle!.absorbedInto, verb!.start, "particle points at the item that absorbed it");
});

test("German: inseparable prefixes are never detached", () => {
  // "verstehen" must not be treated as "stehen" + a particle.
  const lookup = lexicon("verstehen", "bestehen", "erzählen");
  const spans = tokenize("Ich verstehe das nicht.", "de", { lookup });
  const verb = find(spans, "verstehe");
  assert.equal(verb!.detached, undefined);
});

test("English: inflections resolve to a headword", () => {
  const lookup = lexicon("dog", "run", "life", "good", "make", "bus", "study");
  const cases: Array<[string, string]> = [
    ["dogs", "dog"],
    ["running", "run"],
    ["ran", "run"],
    ["lives", "life"],
    ["better", "good"],
    ["making", "make"],
    ["studies", "study"],
    ["bus", "bus"],
  ];
  for (const [surface, expected] of cases) {
    const spans = tokenize(surface, "en", { lookup, compounds: false });
    assert.equal(spans[0].lemmaKey, expected, `${surface} should resolve to ${expected}`);
  }
});

test("English: candidate generation is conservative (no 'bus' -> 'bu')", () => {
  const candidates = englishCandidates("bus");
  assert.equal(candidates[0], "bus");
  assert.ok(!candidates.includes("bu"));
});

test("German: candidate generation offers an infinitive for finite forms", () => {
  const candidates = germanCandidates("steht");
  assert.ok(candidates.includes("stehen"), `expected 'stehen' among ${candidates.join(",")}`);
});

test("Normalisation: NFC is canonical and the search key is separate and lossy by design", () => {
  const decomposed = "Ba\u0308r"; // a + combining diaeresis
  assert.equal(nfc(decomposed), "Bär");
  assert.notEqual(nfc(decomposed), decomposed);

  assert.equal(lemmaKeyOf("Straße"), "straße");
  assert.equal(foldSearchKey("Straße"), "strasse");
  assert.equal(foldSearchKey("Bär"), "baer");

  // The folded key is many-to-one: these two distinct words collide under it.
  assert.equal(foldSearchKey("Bären"), foldSearchKey("Baeren"));
});

test("Umlauts survive tokenization as NFC, not as decomposed text", () => {
  const spans = tokenize("Der Ba\u0308r läuft.", "de");
  const bear = find(spans, "Bär");
  assert.ok(bear, "expected the NFC form of the umlaut token");
  assertLossless("Der Ba\u0308r läuft.", spans);
});

test("Coverage: i+1 is a ratio over word tokens, punctuation excluded", () => {
  const spans = tokenize("The cat sat on the mat.", "en");
  const units = wordSpans(spans);
  assert.equal(units.length, 6, "punctuation must not count toward coverage");

  const knownOne = (s: Span) => s.lemmaKey !== "mat";
  const result = coverage(spans, knownOne);
  assert.equal(result.total, 6);
  assert.equal(result.unknown, 1);
  assert.ok(Math.abs(result.coverage - 5 / 6) < 1e-9);
});

test("Numbers are their own kind, never lemmatised into nonsense", () => {
  const spans = tokenize("In 2026 there were 384 packages.", "en");
  const numbers = spans.filter((s) => s.kind === "number");
  assert.equal(numbers.length, 2);
  assert.equal(numbers[0].surface, "2026");
});

test("German: a word the lexicon already knows is never decomposed", () => {
  // The false split that shipped: "kurzen" (an inflected adjective) split into "kur" + "zen",
  // because both are real entries in a 281k-lemma database. Requiring both parts to exist is not a
  // strong enough guard on its own — the decisive test is whether the whole word resolved.
  const lookup = lexicon("kurz", "kurze", "kur", "zen");
  const spans = tokenize("einen kurzen Text", "de", { lookup });

  const kurzen = spans.find((s) => s.surface === "kurzen");
  assert.ok(kurzen);
  assert.equal(kurzen!.lemmaKey, "kurze", "the inflected form resolves as itself");
  assert.equal(kurzen!.compoundParts, undefined, "a resolved word must not be split");
});

test("German: a genuine compound still decomposes once parts are known", () => {
  // The reason the guard is 'unresolved' rather than 'disable splitting': the compound itself is
  // not in the lexicon, so there is nothing to resolve and its parts are the only way in.
  const lookup = lexicon("wortschatz", "aufbau");
  const spans = tokenize("Der Wortschatzaufbau", "de", { lookup });
  const compound = spans.find((s) => s.surface === "Wortschatzaufbau")!;

  assert.equal(compound.matched, false);
  assert.deepEqual(compound.compoundParts, ["wortschatz", "aufbau"]);
});

test("English: one-letter words resolve to themselves", () => {
  // "a" is in almost every English sentence and "I" is not rare either. Both were permanently
  // unresolved while being present in the vocabulary with glosses, because the candidate builder
  // rejected anything shorter than two characters — a guard that belongs on derived fragments, not
  // on the word itself.
  assert.ok(englishCandidates("A").includes("a"));
  assert.ok(englishCandidates("I").includes("i"));
  assert.ok(englishCandidates("a").includes("a"));

  // Derived fragments are still filtered: stripping "ies" must not offer a one-letter lookup.
  for (const candidate of englishCandidates("babies")) {
    assert.ok(candidate.length >= 2, `derived candidate ${candidate} is too short to look up`);
  }
});
