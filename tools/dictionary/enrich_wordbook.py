"""
Fill the German book's holes from the dictionary, once, before the dictionary goes away.

The Goethe lists carry articles, pronouns and prepositions in paradigm tables rather than as entries, so
they never reached the book — and they are the most frequent words in every passage. This adds them, plus
any other word the apparatus already knew, with provenance recorded as `dictionary` so a later reader can
tell curated data from inherited data.

Run before the legacy tables are dropped; it is a one-way enrichment.

    python3 tools/dictionary/enrich_wordbook.py --db data/flowwing.sqlite3 --lang de
"""
from __future__ import annotations

import argparse
import json
import sqlite3


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="data/flowwing.sqlite3")
    parser.add_argument("--lang", default="de")
    parser.add_argument("--min-level-rows", type=int, default=0)
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    # Only the words the app has actually packed in front of a reader. That is the vocabulary the book has
    # to cover; enriching with the whole dictionary would recreate the thing we are trying to replace.
    used: set[str] = set()
    chunks: dict[str, str] = {}
    for paragraph_id, data in db.execute("SELECT paragraphId, data FROM package_chunks ORDER BY paragraphId, idx"):
        chunks[paragraph_id] = chunks.get(paragraph_id, "") + data
    langs = dict(db.execute("SELECT id, targetLang FROM paragraphs"))
    for paragraph_id, data in chunks.items():
        if langs.get(paragraph_id) != args.lang:
            continue
        try:
            pack = json.loads(data)
        except ValueError:
            continue
        used.update((pack.get("vocabulary") or {}).keys())

    rows = db.execute(
        """
        SELECT w.lemmaKey, w.lemma, w.article, w.level, w.plural,
               (SELECT g.text FROM glosses g
                 WHERE g.targetLang = w.targetLang AND g.lemmaKey = w.lemmaKey AND g.lang = 'en'
                 ORDER BY g.rank ASC LIMIT 1) AS gloss
          FROM words w
         WHERE w.targetLang = ?
        """,
        (args.lang,),
    ).fetchall()
    rows = [row for row in rows if row[0] in used]
    print(f"  words the app has packed: {len(used)} · of those in the dictionary: {len(rows)}")

    existing = {row[0] for row in db.execute("SELECT lemmaKey FROM wordbook WHERE targetLang = ?", (args.lang,))}
    added = 0
    for key, lemma, article, level, plural, gloss in rows:
        if key in existing:
            continue
        forms = [plural] if plural else []
        db.execute(
            """INSERT OR REPLACE INTO wordbook
                 (targetLang, lemmaKey, word, article, level, levelSource, forms, translation,
                  translationSource, updatedAt)
               VALUES (?,?,?,?,?,?,?,?,?,strftime('%s','now')*1000)""",
            (
                args.lang,
                key,
                lemma,
                ({"m": "der", "f": "die", "n": "das"}.get(str(article).strip(), article) if article else None),
                level,
                "dictionary" if level else None,
                json.dumps(forms, ensure_ascii=False),
                gloss,
                "dictionary" if gloss else None,
            ),
        )
        added += 1
    db.commit()

    total = db.execute("SELECT COUNT(*) FROM wordbook WHERE targetLang = ?", (args.lang,)).fetchone()[0]
    print(f"  added {added} words from the dictionary · {args.lang} book now {total} rows")


if __name__ == "__main__":
    main()
