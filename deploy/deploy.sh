#!/usr/bin/env bash
#
# Deploy the current working tree to berry.
#
#   deploy/deploy.sh
#
# The Pi builds its own copy rather than being sent one: it is arm64 and the Mac is not, so a build
# made here would not run there. What travels is source.
#
# Three things are deliberately *not* touched, because they are state rather than code:
#
#   data/flowwing.sqlite3   the vocabulary and everything the reader has marked. A deploy that
#                           overwrote it would throw away the learner.
#   .env.local              the model credential
#   node_modules            platform-specific, rebuilt there when the lockfile changes
#
set -euo pipefail

# The tailnet policy allows one user, and it is not this machine's login name.
HOST="${FLOWWING_HOST:-eustace@berry}"
HOSTNAME_ONLY="${HOST#*@}"
APP="/home/eustace/flowwing/app"

cd "$(dirname "$0")/.."

echo "▸ syncing source"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude data --exclude .git \
  --exclude archive --exclude '.env*' --exclude '*.log' \
  ./ "$HOST:$APP/"

# `npm ci` only when the lockfile actually moved: it is the slowest step and usually unnecessary.
LOCAL_LOCK=$(shasum -a 256 package-lock.json | awk '{print $1}')
REMOTE_LOCK=$(ssh "$HOST" "sha256sum $APP/package-lock.json 2>/dev/null | awk '{print \$1}'" || true)
if [ "$LOCAL_LOCK" != "$REMOTE_LOCK" ]; then
  echo "▸ dependencies changed — installing"
  ssh "$HOST" "cd $APP && /usr/local/bin/npm ci --no-audit --no-fund 2>&1 | tail -2"
else
  echo "▸ dependencies unchanged"
fi

echo "▸ building on $HOST"
ssh "$HOST" "cd $APP && /usr/local/bin/npm run build 2>&1 | tail -4"

echo "▸ restarting"
ssh "$HOST" "sudo -n systemctl restart flowwing && sleep 4 && systemctl is-active flowwing"

# `/api/auth/me` and not `/api/me`: the latter is behind the gate and answers 401 to a healthy app.
CODE=$(ssh "$HOST" "curl -s -o /dev/null -w '%{http_code}' -m 15 http://127.0.0.1:3100/api/auth/me")
if [ "$CODE" != "200" ]; then
  echo "✗ the app answered $CODE — check: ssh $HOST 'sudo journalctl -u flowwing -n 40'"
  exit 1
fi
echo "✓ live at http://$HOSTNAME_ONLY:3100"
