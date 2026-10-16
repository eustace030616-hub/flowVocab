#!/usr/bin/env python3
"""
Compile German morphology into tables the runtime can look up.

    ./.venv-data/bin/python src/scripts/morphology/compile_german.py --out data/de/morphology.jsonl

## Why this exists

The runtime used to decide German morphology with hand-written suffix rules, and the rules kept
being wrong in ways a reader notices: `liest` resolved to the noun *Liest*, `kurzen` to the noun
*Kurze*, `wächst eine` fused into *einwachsen*, `setzte` into *gegenübersetzen*, `got` and `grew`
resolved to nothing. Every fix moved a rule into a table, which is the signal that the linguistics
belongs in a library and only the table belongs here.

So this is a **compiler, not a service**. spaCy analyses a corpus once, offline; the runtime keeps
doing what it already does well — a dictionary lookup — and never calls Python. The output is a
table, which means it can be diffed, reviewed, tested and shipped.

## What it emits

One JSON object per line, three kinds:

    {"kind":"lemma","form":"liest","lemma":"lesen","pos":"VERB"}
    {"kind":"particle","particle":"auf","verb":"stehen","source":"parse"}
    {"kind":"compound","form":"wortschatzaufbau","parts":["wortschatz","aufbau"],"source":"split"}

## The three tables, and why each one replaces a rule

**lemma** — form to dictionary form. spaCy's lemmatiser is trained on German treebanks; the rules it
replaces were guessing at suffixes and matching the wrong homograph.

**particle** — separated verb prefixes, `auf` … `stehen`. This is the one that *cannot* be done with
string rules at all: whether a word is a particle is a syntactic fact, and the dependency parse says
so directly (the particle attaches to the verb as `svp`/`separated verb prefix`). Every over-merge
this app has produced — *Kurztext*, *einwachsen*, *gegenübersetzen* — came from guessing at that with
proximity and word lists.

**compound** — German compounds split into parts. spaCy does not split compounds, so this uses a
frequency/lexicon-driven splitter and then validates every part against the vocabulary. The runtime
splitting it replaces produced *Kurztext* from "kurzen Text".

## What it deliberately does not do

No glossing, no difficulty, no learner model — the parts of the app that are not linguistics and have
no library to adopt. This script only answers "what word is this, really".
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable, Iterator
from pathlib import Path


def load_corpus(path: Path) -> list[str]:
    """Plain text, one passage per blank-line-separated block."""
    text = path.read_text(encoding="utf-8")
    return [block.strip().replace("\n", " ") for block in text.split("\n\n") if block.strip()]


def analyse(nlp, texts: Iterable[str]) -> Iterator[dict]:
    """
    Walk the parses and emit lemma and particle rows.

    `token.lemma_` is already lowercased and resolved; the part of speech is kept because the runtime
    keys its entries by (lemma, part of speech) and a lemma without one fragments the vocabulary.
    """
    for doc in nlp.pipe(texts, batch_size=32):
        for token in doc:
            if token.is_space or token.is_punct:
                continue

            lemma = token.lemma_.strip().lower()
            form = token.text.strip().lower()
            if lemma and form and lemma != "-" and form != lemma:
                yield {"kind": "lemma", "form": form, "lemma": lemma, "pos": token.pos_}

            # A separated verb prefix: `auf` in "er steht früh auf". The dependency label is the
            # syntactic statement that this word belongs to that verb, which no distance heuristic can
            # make. `token.head` is the verb it separated from.
            if token.dep_ in ("svp", "separated verb prefix") and token.head is not None:
                head = token.head
                verb = (head.lemma_ or head.text).strip().lower()
                if verb and form:
                    yield {
                        "kind": "particle",
                        "particle": form,
                        "verb": verb,
                        "verbForm": head.text.strip().lower(),
                        "verbPos": head.pos_,
                        "source": "parse",
                    }


def split_compounds(forms: Iterable[str], vocabulary: set[str], min_part: int = 4) -> Iterator[dict]:
    """
    Split compounds by finding the split whose parts are all real words.

    A lexicon-driven splitter rather than a statistical one, deliberately: with 280k lemmas available
    the constraint "every part must be a known word" is strong, and it is the same constraint the
    runtime used — the difference is that the result is frozen here and reviewed, instead of being
    recomputed (and occasionally invented) on every request.

    Parts are tried longest-suffix-first, because German compounds are head-final: the last element
    carries the meaning.
    """
    for form in forms:
        if len(form) < min_part * 2 or form in vocabulary:
            # A word the vocabulary already holds needs no decomposition.
            continue
        best: list[str] | None = None
        for cut in range(min_part, len(form) - min_part + 1):
            left, right = form[:cut], form[cut:]
            if left in vocabulary and right in vocabulary:
                # Prefer the split with the longest head, then the most even one.
                if best is None or len(right) > len(best[1]):
                    best = [left, right]
        if best:
            yield {"kind": "compound", "form": form, "parts": best, "source": "lexicon-split"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile German morphology into runtime tables.")
    parser.add_argument("--corpus", default="data/de/corpus.txt", help="text to parse for particles")
    parser.add_argument("--vocabulary", default="data/de/vocabulary.txt", help="one lemma per line")
    parser.add_argument("--forms", default="data/de/forms.txt", help="surface forms to lemmatise")
    parser.add_argument("--out", default="data/de/morphology.jsonl")
    parser.add_argument("--model", default="de_core_news_md")
    parser.add_argument("--no-compounds", action="store_true")
    args = parser.parse_args()

    try:
        import spacy
    except ImportError:
        print("spaCy is not installed. ./.venv-data/bin/pip install spacy", file=sys.stderr)
        return 2

    nlp = spacy.load(args.model)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    counts = {"lemma": 0, "particle": 0, "compound": 0}
    seen: set[tuple] = set()

    with out_path.open("w", encoding="utf-8") as handle:
        def emit(row: dict) -> None:
            key = (row["kind"], row.get("form") or row.get("particle"), row.get("lemma") or row.get("verb"))
            if key in seen:
                return
            seen.add(key)
            counts[row["kind"]] += 1
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

        corpus_path = Path(args.corpus)
        if corpus_path.exists():
            for row in analyse(nlp, load_corpus(corpus_path)):
                emit(row)
            print(f"  parsed {len(load_corpus(corpus_path))} passage(s) for particles", file=sys.stderr)

        forms_path = Path(args.forms)
        if forms_path.exists():
            forms = [line.strip() for line in forms_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            # Lemmatise the vocabulary's own surface forms in batches; this is the table that fixes
            # inflections, and it is why the runtime needs no suffix rules.
            for row in analyse(nlp, forms):
                emit(row)

            if not args.no_compounds:
                vocabulary_path = Path(args.vocabulary)
                vocabulary = (
                    {line.strip().lower() for line in vocabulary_path.read_text(encoding="utf-8").splitlines() if line.strip()}
                    if vocabulary_path.exists()
                    else set()
                )
                if vocabulary:
                    for row in split_compounds((f.lower() for f in forms), vocabulary):
                        emit(row)

    print(f"  wrote {out_path} · " + " · ".join(f"{k} {v}" for k, v in counts.items()), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
