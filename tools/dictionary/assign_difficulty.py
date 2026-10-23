"""
Give every word book row a continuous difficulty.

A CEFR level is five values; a placement test that spreads items across ten difficulty bands needs more
resolution than that. So each word gets the midpoint of its level's slice, shifted by how common the word
is: a frequent word in B1 sits a little easier than a rare one, which is enough to fill the bands without
contradicting the curated level.

    python3 tools/dictionary/assign_difficulty.py --db data/flowwing.sqlite3 --lang de

Run it after `dict:seed`, which loads the book without a difficulty column.
"""
from __future__ import annotations

import argparse
import sqlite3

from wordfreq import zipf_frequency

BANDS = {"A1": 0, "A2": 1, "B1": 2, "B2": 3, "C1": 4, "C2": 5}
LEVELS = len(BANDS)
# Wide enough that each level spans several bands, narrow enough that a word never lands in a level it does
# not belong to.
SPREAD = 0.35


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="data/flowwing.sqlite3")
    parser.add_argument("--lang", default="de")
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    rows = db.execute(
        "SELECT lemmaKey, word, level FROM wordbook WHERE targetLang = ? AND level IS NOT NULL",
        (args.lang,),
    ).fetchall()

    updated = 0
    for key, word, level in rows:
        index = BANDS.get(level)
        if index is None:
            continue
        base = (index + 0.5) / LEVELS
        zipf = zipf_frequency(word, args.lang)
        # zipf runs 0 (unseen) to ~8 (the). Centre it on the level's midpoint.
        offset = ((zipf / 8.0) - 0.5) * SPREAD
        difficulty = max(0.01, min(0.99, base + offset))
        db.execute(
            "UPDATE wordbook SET difficulty = ? WHERE targetLang = ? AND lemmaKey = ?",
            (difficulty, args.lang, key),
        )
        updated += 1
    db.commit()

    bands = db.execute(
        "SELECT CAST(difficulty * 10 AS INTEGER) AS band, COUNT(*) FROM wordbook "
        "WHERE targetLang = ? AND difficulty IS NOT NULL GROUP BY band ORDER BY band",
        (args.lang,),
    ).fetchall()
    print(f"  {updated} rows given a difficulty · populated bands: {len(bands)}")
    print("  per band:", " ".join(f"{band}:{count}" for band, count in bands))


if __name__ == "__main__":
    main()
