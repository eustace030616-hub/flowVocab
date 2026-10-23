"""
SoMaJo as a sidecar: segmentation only.

SoMaJo splits text into sentences and tokens — abbreviations, "z.B.", ellipses, quotes, emoji, URLs —
which is the step our own tokeniser has been approximating with rules. It does *not* lemmatise, and lemma
resolution is what the dictionary is actually for, so this process deliberately returns tokens and
nothing else: the existing pipeline keeps the dictionary in charge of lemmas.

    POST /tokenize {"text": "...", "lang": "de"} → {"tokens": [{text, start, end}], "sentences": n}

Run it directly for a test:

    tools/venv/bin/python tools/tokenize/server.py --port 3110
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from somajo import SoMaJo
from simplemma import lemmatize

# SoMaJo 2.5 ships two models: the German CMC tokeniser and the English Penn-Treebank one.
TOKENIZERS = {"de": "de_CMC", "en": "en_PTB"}


def tokenize(text: str, lang: str) -> dict:
    name = TOKENIZERS.get(lang, "de_web")
    somajo = SoMaJo(name, split_camel_case=False)
    sentences = list(somajo.tokenize_text([text]))

    tokens: list[dict] = []
    cursor = 0
    for sentence in sentences:
        for token in sentence:
            surface = token.text
            start = find_from(text, surface, cursor)
            if start < 0:
                # SoMaJo normalised something (a space, a quotation mark); skip it rather than
                # invent an offset that would point at the wrong characters in the reader.
                continue
            # Simplemma is the lemmatiser the dictionary's inflections table used to be: it reads a
            # surface form and returns the citation form, from its own in-memory data, per token.
            lemma = lemmatize(surface, lang=lang) if any(ch.isalpha() for ch in surface) else surface
            tokens.append({"text": surface, "start": start, "end": start + len(surface), "lemma": lemma})
            cursor = start + len(surface)
    return {"tokens": tokens, "sentences": len(sentences)}


def find_from(haystack: str, needle: str, cursor: int) -> int:
    """The next occurrence at or after `cursor`, preferring the one that follows only whitespace."""
    index = haystack.find(needle, cursor)
    while index >= 0:
        between = haystack[cursor:index]
        if between.strip() == "":
            return index
        index = haystack.find(needle, index + 1)
    return haystack.find(needle, cursor)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 — the stdlib names it this way
        if self.path != "/tokenize":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            result = tokenize(str(body.get("text", "")), str(body.get("lang", "de")))
            payload = json.dumps(result).encode()
            self.send_response(200)
        except Exception as error:  # noqa: BLE001 — a sidecar must answer, not crash
            import traceback

            payload = json.dumps({"error": f"{type(error).__name__}: {error}", "trace": traceback.format_exc()}).encode()
            self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args) -> None:  # silence the per-request line
        return


def main() -> None:
    port = 3110
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
