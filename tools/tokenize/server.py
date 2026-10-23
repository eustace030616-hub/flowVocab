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

from HanTa import HanoverTagger as ht
from simplemma import lemmatize
from somajo import SoMaJo

# SoMaJo 2.5 ships two models: the German CMC tokeniser and the English Penn-Treebank one.
TOKENIZERS = {"de": "de_CMC", "en": "en_PTB"}

# Loaded once: the German model is a few megabytes of HMM tables and takes a couple of seconds.
TAGGERS = {}


MODELS = {"de": "morphmodel_ger.pgz", "en": "morphmodel_en.pgz"}


def tagger(lang: str):
    """HanTa's model for this language, loaded once. English has one too — `morphmodel_en.pgz`."""
    model = MODELS.get(lang)
    if model is None:
        return None
    if lang not in TAGGERS:
        TAGGERS[lang] = ht.HanoverTagger(model)
    return TAGGERS[lang]


def join_particles(tagged: list[tuple[str, str, str]]) -> list[int]:
    """
    Rewrite a separable verb into its full lemma, and record which token absorbed which.

    HanTa tags the detached prefix as PTKVZ — the piece of information no lemmatiser gave us. The join
    stops being a guess about clause position plus a lookup in a pair table: the tag says it is a
    particle, and the nearest preceding verb is its host.

        wache … auf   → aufwachen
        findet … statt → stattfinden

    Returns, per token index, the index of the token it was absorbed into, or -1.
    """
    absorbed = [-1] * len(tagged)
    for index, (_word, lemma, tag) in enumerate(tagged):
        if tag != "PTKVZ" or not lemma:
            continue
        for back in range(index - 1, -1, -1):
            host_tag = tagged[back][2]
            if host_tag.startswith(("VV", "VA", "VM")):
                tagged[back] = (tagged[back][0], lemma + tagged[back][1], host_tag)
                absorbed[index] = back
                break
    return absorbed


def tokenize(text: str, lang: str) -> dict:
    somajo = SoMaJo(TOKENIZERS.get(lang, "de_CMC"), split_camel_case=False)
    sentences = list(somajo.tokenize_text([text]))
    model = tagger(lang)

    tokens: list[dict] = []
    cursor = 0
    for sentence in sentences:
        surfaces = [token.text for token in sentence]
        if model is not None:
            tagged = [(word, lemma, tag) for word, lemma, tag in model.tag_sent(surfaces)]
        else:
            tagged = [
                (word, lemmatize(word, lang=lang) if any(ch.isalpha() for ch in word) else word, "")
                for word in surfaces
            ]
        absorbed = join_particles(tagged)

        for position, token in enumerate(sentence):
            surface = token.text
            start = find_from(text, surface, cursor)
            if start < 0:
                # SoMaJo normalised something (a space, a quotation mark); skip it rather than invent an
                # offset that would point at the wrong characters in the reader.
                continue
            lemma = tagged[position][1] if position < len(tagged) else surface
            tag = tagged[position][2] if position < len(tagged) else ""
            entry = {"text": surface, "start": start, "end": start + len(surface), "lemma": lemma, "tag": tag}
            host = absorbed[position] if position < len(absorbed) else -1
            if 0 <= host < len(sentence):
                host_start = find_from(text, sentence[host].text, cursor)
                if host_start >= 0:
                    entry["absorbedInto"] = host_start
            tokens.append(entry)
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
