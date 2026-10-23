"""
Build the Goethe dictionary: word, article, level, listed forms.

Run it with a Python that has pypdf, from the app directory:

    python3 tools/dictionary/build_goethe.py

Output: /tmp/goethe-dict.json - {lemmaKey: {word, article, level, forms, inDictionary}}.

The lists are (c) Goethe-Institut. This is a build-time tool: it reads PDFs the operator already
has and writes a working file. Do not commit the extracted list, and do not ship it in the app
without permission.

Extraction uses `layout` mode, which keeps the columns, so the rule is positional rather than lexical:
the leftmost cell of a line is the headword, and a cell that ends in sentence punctuation is an example.

The cleaning pass is what removes the noise that made the first attempt unusable (verb principal parts
and inflected forms occupying the headword column): a candidate that is a *form* of another word — the
dictionary's own inflections table says surface ≠ lemma — is dropped unless it is also a headword.
"""
from __future__ import annotations

import json
import re
import sqlite3

from pypdf import PdfReader

FILES = {
    "A1": "/Users/penghaoxi/Downloads/A1_SD1_Wortliste_02.pdf",
    "A2": "/Users/penghaoxi/Downloads/Goethe-Zertifikat_A2_Wortliste.pdf",
    "B1": "/Users/penghaoxi/Downloads/Goethe-Zertifikat_B1_Wortliste.pdf",
}
DB = "/Users/penghaoxi/workspace/flowwing/app/data/flowwing.sqlite3"

CELL = re.compile(r"\S(?:.*?\S)?(?=\s{8,}|$)")
ARTICLES = {"der", "die", "das", "den", "dem"}
FURNITURE = re.compile(
    r"^(goethe|zertifikat|wortliste|inhalt|seite|deutschprüfung|jugendliche|erwachsene|"
    r"zertifiziert|durch|vs_|start deutsch|ösd|niveau|aufbau|hinweis|abkürzung|symbole|inventare|"
    r"\d+\.?\d*\s*$|[A-C][12]_Wortliste)",
    re.I,
)


def clean_cell(cell: str) -> tuple[str | None, str, list[str]]:
    cell = re.sub(r"\s+", " ", cell.strip()).strip("–-").strip()
    parts = [part.strip() for part in cell.split(",")]
    head = parts[0]
    forms = [part for part in parts[1:] if part]
    tokens = head.split()
    if tokens and tokens[0].lower() in ARTICLES:
        return tokens[0].lower(), " ".join(tokens[1:]), forms
    if tokens and "/" in tokens[0] and all(p.lower() in ARTICLES for p in tokens[0].split("/")):
        return tokens[0].lower(), " ".join(tokens[1:]), forms
    return None, head, forms


PLAIN_GAP = re.compile(r"\s{2,}|\t")


def extract_plain(level: str, path: str) -> dict[str, dict]:
    """The plain-text reading: headword cell, a gap, then the example."""
    entries: dict[str, dict] = {}
    for page in PdfReader(path).pages:
        for raw in (page.extract_text() or "").split("\n"):
            if not raw.strip() or raw[:1] == " ":
                continue
            if not PLAIN_GAP.search(raw):
                continue
            cell = PLAIN_GAP.split(raw, maxsplit=1)[0].strip()
            if not cell or FURNITURE.match(cell) or len(cell) > 60:
                continue
            if not re.search(r"[A-Za-zÄÖÜäöüß]", cell):
                continue
            article, word, forms = clean_cell(cell)
            if len(word) < 2 or len(word) > 48:
                continue
            entries.setdefault(word.lower(), {"word": word, "article": article, "level": level, "forms": forms})
    return entries


def extract(level: str, path: str) -> dict[str, dict]:
    entries: dict[str, dict] = extract_plain(level, path)
    for page in PdfReader(path).pages:
        try:
            text = page.extract_text(extraction_mode="layout") or ""
        except Exception:
            continue
        for line in text.split("\n"):
            if not line.strip():
                continue
            for cell in CELL.findall(line):
                candidate = cell.strip()
                if not candidate:
                    continue
                if re.search(r"[.!?]\s*$", candidate):
                    break  # an example sentence: nothing after it on this line is a headword
                if FURNITURE.match(candidate) or len(candidate) > 60:
                    continue
                if not re.search(r"[A-Za-zÄÖÜäöüß]", candidate):
                    continue
                article, word, forms = clean_cell(candidate)
                if len(word) < 2 or len(word) > 48:
                    continue
                key = word.lower()
                if key in entries:
                    continue
                entries[key] = {"word": word, "article": article, "level": level, "forms": forms}
                break
    return entries


def main() -> None:
    raw: dict[str, dict[str, dict]] = {}
    for level, path in FILES.items():
        raw[level] = extract(level, path)
        print(f"  {level}: {len(raw[level]):5} candidates")

    db = sqlite3.connect(DB)
    headwords = {row[0] for row in db.execute("SELECT lemmaKey FROM words WHERE targetLang='de'")}
    forms = {row[0]: row[1] for row in db.execute("SELECT form, baseLemmaKey FROM inflections WHERE targetLang='de'")}

    kept: dict[str, dict] = {}
    dropped_forms = 0
    for level in ("A1", "A2", "B1"):
        for key, entry in raw[level].items():
            is_headword = key in headwords
            lemma_of_form = forms.get(key)
            if not is_headword and lemma_of_form and lemma_of_form != key:
                dropped_forms += 1
                continue
            kept.setdefault(key, {**entry, "inDictionary": is_headword})

    print(f"\n  after dropping inflected forms and principal parts: {len(kept)} ({dropped_forms} dropped)")
    print(f"  with a gender:   {sum(1 for e in kept.values() if e['article'])}")
    print(f"  with forms:      {sum(1 for e in kept.values() if e['forms'])}")
    print(f"  already a dictionary headword: {sum(1 for e in kept.values() if e['inDictionary'])}")
    for level in ("A1", "A2", "B1"):
        print(f"  {level}: {sum(1 for e in kept.values() if e['level'] == level)}")

    for probe in ("ice", "bahn", "bein", "zug", "aufwachen", "regel", "mieterhöhung", "anschluss"):
        print(f"  {probe:15} → {kept.get(probe, 'not present')}")

    with open("/tmp/goethe-dict.json", "w", encoding="utf-8") as handle:
        json.dump(kept, handle, ensure_ascii=False, indent=1)
    print("\n  wrote /tmp/goethe-dict.json")


if __name__ == "__main__":
    main()
