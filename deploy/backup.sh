#!/usr/bin/env bash
#
# Take a consistent snapshot of the database.
#
#   deploy/backup.sh [destination]
#
# Not `cp` and not `rsync`: with WAL enabled, recent commits live in the `-wal` file, so copying the
# main file alone can capture a database that is missing the last few transactions — and copying all
# three files while writes are happening can capture a torn state. `VACUUM INTO` asks SQLite for a
# snapshot, which is what it is good at.
set -euo pipefail

HOST="${FLOWWING_HOST:-eustace@berry}"
DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/backups}"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"

# The snapshot is taken by a small script rather than an inline `-e`, because the quoting of JS
# inside shell inside ssh is exactly the kind of thing that fails silently in production.
ssh "$HOST" 'cat > /tmp/flowwing-snapshot.mjs' <<'JS'
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";

const src = process.env.HOME + "/flowwing/app/data/flowwing.sqlite3";
const out = "/tmp/flowwing-snapshot.sqlite3";
try { unlinkSync(out); } catch {}

const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${out}'`);
db.close();
console.log("snapshot written");
JS
ssh "$HOST" 'node /tmp/flowwing-snapshot.mjs'

rsync -az "$HOST:/tmp/flowwing-snapshot.sqlite3" "$DEST/flowwing-$STAMP.sqlite3"
ssh "$HOST" 'rm -f /tmp/flowwing-snapshot.sqlite3'

# Keep the last few only: a backup directory that grows without bound is its own problem.
ls -1t "$DEST"/flowwing-*.sqlite3 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "✓ $DEST/flowwing-$STAMP.sqlite3 ($(du -h "$DEST/flowwing-$STAMP.sqlite3" | cut -f1))"
