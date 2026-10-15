#!/usr/bin/env bash
#
# Fetch the open datasets Flowwing builds on.
#
# Deliberately NOT in git: third-party data belongs in the build, not in the repository, and
# the offline-only calibration sources must never be committed at all (see
# src/lib/licence/datasets.ts for which is which).
#
#   ./fetch-data.sh          small, shippable sources (~300 KB)
#   ./fetch-data.sh --full   also the large German corpora (~520 MB)
#
# Every download is recorded in data/SOURCES.json with its sha256, so a build can be
# reproduced and a licence review can check exactly which bytes were used.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DATA="$ROOT/data"
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

mkdir -p "$DATA/en" "$DATA/de"
SOURCES="$DATA/SOURCES.json"
[ -f "$SOURCES" ] || echo '{"retrievedAt": "", "files": []}' > "$SOURCES"

fetch() {
  local url="$1" dest="$2"
  if [ -f "$dest" ]; then
    echo "  have  $(basename "$dest")"
  else
    echo "  get   $(basename "$dest")"
    curl -fsSL --retry 3 --max-time 300 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
}

echo "Open datasets (shippable):"
fetch "https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/cefrj-vocabulary-profile-1.5.csv" \
      "$DATA/en/cefrj-vocabulary-profile-1.5.csv"
fetch "https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/octanove-vocabulary-profile-c1c2-1.0.csv" \
      "$DATA/en/octanove-vocabulary-profile-c1c2-1.0.csv"
fetch "https://www.dwds.de/lemma/csv" "$DATA/de/dwds-lemmata.csv"
fetch "https://raw.githubusercontent.com/ph98/german-cefr-wordlist/main/data/german_cefr_wordlist.json" \
      "$DATA/de/ph98-german-cefr-wordlist.json"

if [ "$FULL" = "1" ]; then
  echo "Large corpora (--full):"
  fetch "https://downloads.wortschatz-leipzig.de/corpora/deu_news_2024_1M.tar.gz" \
        "$DATA/de/leipzig-deu_news_2024_1M.tar.gz"
  fetch "https://kaikki.org/dictionary/German/kaikki.org-dictionary-German.jsonl.gz" \
        "$DATA/de/kaikki-de.jsonl.gz"
else
  echo "Skipping large corpora (Leipzig ~229 MB, kaikki German ~294 MB). Use --full."
fi

echo
echo "Recording checksums in data/SOURCES.json"
python3 - "$DATA" "$SOURCES" <<'PY'
import hashlib, json, os, sys, datetime

data_dir, sources_path = sys.argv[1], sys.argv[2]
files = []
for root, _dirs, names in os.walk(data_dir):
    for name in sorted(names):
        if name == "SOURCES.json":
            continue
        path = os.path.join(root, name)
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        files.append({
            "path": os.path.relpath(path, data_dir),
            "bytes": os.path.getsize(path),
            "sha256": h.hexdigest(),
        })

with open(sources_path, "w") as fh:
    json.dump({
        "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "files": files,
    }, fh, indent=2)
print(f"  {len(files)} file(s) recorded")
PY

echo
echo "REMINDER: offline-only sources (Goethe/DTZ/telc wordlists, DeReWo) must never be placed"
echo "here. Put them under data/offline-anchors/, which is git-ignored and never imported."
