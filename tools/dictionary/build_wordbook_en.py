"""
Build the English word book: CEFR levels from the CEFR-J dataset, Chinese glosses from ECDICT.

Both sources are MIT-licensed, which is why the English book has none of the German book's restrictions.

    python3 tools/dictionary/build_wordbook_en.py \
        --cefr /tmp/word_cefr.db --ecdict /tmp/ecdict.csv --out /tmp/wordbook-en.json

Level: the `word_pos.level` column is a float on a 1–6 scale (A1–C2). A word appears under several parts
of speech with different levels; the most frequent one wins, because that is the reading a learner meets
first. Rounded to the nearest band.

Translation: ECDICT's `translation` column is Chinese, one sense per line. The first line is kept, with
its leading part-of-speech tag stripped.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3

BANDS = {1: "A1", 2: "A2", 3: "B1", 4: "B2", 5: "C1"}
# The dataset scores 1–6, but 6.0 is its bucket for words with no CEFR-J level — 126k of 172k entries
# sit there, so treating it as C2 would label three quarters of English as advanced. Anything above C1 is
# dropped: a word without a level is better than a word with a wrong one.
MAX_LEVEL = 5.0
POS_PREFIX = re.compile(r"^\s*(?:[a-z]+\.\s*)+", re.I)


def levels(path: str) -> dict[str, dict]:
    db = sqlite3.connect(path)
    rows = db.execute(
        """
        SELECT w.word, wp.level, wp.frequency_count
          FROM word_pos wp
          JOIN words w ON w.word_id = wp.word_id
         WHERE wp.level IS NOT NULL
        """
    ).fetchall()
    best: dict[str, tuple[float, int]] = {}
    for word, level, frequency in rows:
        key = word.strip().lower()
        if not key:
            continue
        current = best.get(key)
        if current is None or (frequency or 0) > current[1]:
            best[key] = (float(level), int(frequency or 0))
    book: dict[str, dict] = {}
    for key, (level, _frequency) in best.items():
        if level > MAX_LEVEL:
            continue
        book[key] = {"word": key, "level": BANDS[max(1, round(level))], "levelRaw": level}
    return book


def translations(path: str, wanted: set[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    with open(path, encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            word = (row.get("word") or "").strip().lower()
            if word not in wanted or word in found:
                continue
            text = (row.get("translation") or "").strip()
            if not text:
                continue
            first = text.replace("\\n", "\n").split("\n")[0].strip()
            first = POS_PREFIX.sub("", first)
            first = first.split("；")[0].split(";")[0].strip()
            if first:
                found[word] = first
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cefr", default="/tmp/word_cefr.db")
    parser.add_argument("--ecdict", default="/tmp/ecdict.csv")
    parser.add_argument("--out", default="/tmp/wordbook-en.json")
    args = parser.parse_args()

    book = levels(args.cefr)
    glossed = translations(args.ecdict, set(book))

    for key, entry in book.items():
        entry["translation"] = glossed.get(key)
        entry["translationSource"] = "ecdict" if key in glossed else None
        entry["levelSource"] = "cefr-j"
        entry["article"] = None
        entry["forms"] = []

    json.dump(book, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    by_level: dict[str, int] = {}
    for entry in book.values():
        by_level[entry["level"]] = by_level.get(entry["level"], 0) + 1
    print(f"  {len(book)} words · {len(glossed)} with a Chinese gloss ({round(100 * len(glossed) / max(1, len(book)))}%)")
    print("  by level:", " · ".join(f"{k} {v}" for k, v in sorted(by_level.items())))
    for probe in ("dog", "give", "up", "proficiency", "sustain", "arrive"):
        print(f"  {probe:12} → {book.get(probe)}")


if __name__ == "__main__":
    main()
