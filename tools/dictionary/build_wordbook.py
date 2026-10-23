"""
Build the word book: Goethe as ground truth for level, wordfeather for translations.

This is a NEW dictionary, not an extension of the existing vocabulary. It answers two questions — what
level is this word, and what does it mean — and it owns its own rows.

    python3 tools/dictionary/build_wordbook.py \
        --goethe /tmp/goethe-dict.json \
        --wordfeather /tmp/words_final.json \
        --out /tmp/wordbook.json

Precedence, deliberately asymmetric:

    level        Goethe where the word is listed, wordfeather otherwise   (ground truth, then filler)
    gender       Goethe, then wordfeather's `article` field
    forms        Goethe's plural and principal parts, then wordfeather's
    translation  wordfeather only — Goethe lists carry no glosses

Both inputs are third-party data with conditions attached:

    Goethe word lists     (c) Goethe-Institut. Build-time reference; not shipped.
    wordfeather           CC BY-NC 4.0 — attribution, non-commercial. Fine for a development build,
                          not for a paid product without permission.

Neither the inputs nor the output are committed to the repository.
"""
from __future__ import annotations

import argparse
import json

ARTICLES = {"der": "der", "die": "die", "das": "das"}
ARTICLE_OF = {"m": "der", "f": "die", "n": "das", "m.": "der", "f.": "die", "n.": "das"}


def split_german(de: str) -> tuple[str | None, str, list[str]]:
    """'die Probezeit, -en' → ('die', 'Probezeit', ['-en'])."""
    parts = [part.strip() for part in de.strip().split(",")]
    head = parts[0]
    forms = [part for part in parts[1:] if part]
    tokens = head.split()
    if tokens and tokens[0].lower() in ARTICLES:
        return ARTICLES[tokens[0].lower()], " ".join(tokens[1:]), forms
    return None, head, forms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--goethe", default="/tmp/goethe-dict.json")
    parser.add_argument("--wordfeather", default="/tmp/words_final.json")
    parser.add_argument("--out", default="/tmp/wordbook.json")
    args = parser.parse_args()

    goethe = json.load(open(args.goethe, encoding="utf-8"))
    wordfeather = json.load(open(args.wordfeather, encoding="utf-8"))

    book: dict[str, dict] = {}
    for key, entry in goethe.items():
        book[key] = {
            "word": entry["word"],
            "article": entry["article"],
            "level": entry["level"],
            "levelSource": "goethe",
            "forms": entry.get("forms") or [],
            "translation": None,
            "translationSource": None,
        }

    for record in wordfeather:
        article, word, forms = split_german(str(record.get("de", "")))
        if not word:
            continue
        key = word.lower()
        translation = str(record.get("en", "")).strip() or None
        level = str(record.get("level", "")).strip() or None
        article = article or ARTICLE_OF.get(str(record.get("article", "")).strip())

        target = book.get(key)
        if target is None:
            book[key] = {
                "word": word,
                "article": article,
                "level": level,
                "levelSource": "wordfeather" if level else None,
                "forms": forms,
                "translation": translation,
                "translationSource": "wordfeather" if translation else None,
            }
            continue

        # Goethe's level wins; everything else fills a hole.
        if translation:
            target["translation"] = translation
            target["translationSource"] = "wordfeather"
        if not target["article"] and article:
            target["article"] = article
        if not target["forms"] and forms:
            target["forms"] = forms
        if not target["level"] and level:
            target["level"] = level
            target["levelSource"] = "wordfeather"

    json.dump(book, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"  {len(book)} entries → {args.out}")
    by_level: dict[str, int] = {}
    for entry in book.values():
        by_level[entry["level"] or "none"] = by_level.get(entry["level"] or "none", 0) + 1
    print("  by level:", " · ".join(f"{k} {v}" for k, v in sorted(by_level.items())))
    print(f"  translations {sum(1 for e in book.values() if e['translation'])} · articles {sum(1 for e in book.values() if e['article'])}")


if __name__ == "__main__":
    main()
