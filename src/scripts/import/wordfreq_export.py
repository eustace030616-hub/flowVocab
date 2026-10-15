#!/usr/bin/env python3
"""
Emit wordfreq Zipf scores for a word list.

    ./.venv-data/bin/python src/scripts/import/wordfreq_export.py <lang> <words.txt> <out.json>

wordfreq is a Python package with no Node equivalent, so the frequency step is a small,
single-purpose Python program rather than a dependency of the application. It is called by
`npm run export:frequency` and its output is read by `import-frequency.ts`.

Licence: wordfreq's data is CC BY-SA 4.0 (code Apache-2.0). Its NOTICE.md requires crediting
the author by the exact name "Robyn Speer" — see LICENSES/wordfreq-3.1.1.txt.

Zipf is log10(occurrences per billion words): higher means more frequent, and difficulty
*decreases* as Zipf rises.
"""

import json
import sys
from wordfreq import zipf_frequency


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    lang, words_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(words_path, encoding="utf-8") as handle:
        words = [line.strip() for line in handle if line.strip()]

    scores: dict[str, float] = {}
    known = 0
    # German nouns are capitalised in running text but the learner's lemma key is lowercase, and
    # wordfreq is case-sensitive. Score both spellings and keep the more frequent reading, so a
    # word is not called rare merely because it is normally written with a capital.
    for word in words:
        value = zipf_frequency(word, lang)
        lowered = word.lower()
        if lowered != word:
            value = max(value, zipf_frequency(lowered, lang))
        if value > 0:
            known += 1
        scores[lowered] = round(value, 4)

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "lang": lang,
                "source": "wordfreq",
                "license": "CC BY-SA 4.0",
                "attribution": "Robyn Speer",
                "words": len(scores),
                "known": known,
                "zipf": scores,
            },
            handle,
        )

    print(f"  {lang}: {len(scores)} words scored, {known} with a non-zero Zipf → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
