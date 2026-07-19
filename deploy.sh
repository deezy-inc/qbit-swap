#!/usr/bin/env bash
# Deploy the local working tree to a swap server (rsync → npm install → build → restart the
# coordinator), with a health check. Set the target yourself — no host is baked in:
#
#   SERVER=ubuntu@your-host ./deploy.sh
#   SERVER=ubuntu@your-host REMOTE=/opt/qbit-otc ./deploy.sh
#
# The coordinator restart drops live SSE connections briefly; in-flight swaps survive via COORD_DB.
set -euo pipefail

SERVER="${SERVER:?set SERVER=ubuntu@<host> — the deploy target}"
REMOTE="${REMOTE:-/home/ubuntu/qbit-otc}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "→ syncing $HERE → $SERVER:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude 'webapp/dist' \
  --exclude '*.log' --exclude 'webapp/deploy/lab.env' \
  "$HERE"/ "$SERVER:$REMOTE"/

echo "→ install deps + build + restart on $SERVER"
ssh "$SERVER" "REMOTE='$REMOTE' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE"
for pkg in client coordinator webapp; do ( cd "$pkg" && npm install --no-audit --no-fund >/dev/null ); done
( cd webapp && bash build.sh )
sudo systemctl restart qbit-swap
sleep 4
curl -fsS --max-time 8 http://127.0.0.1:8787/health >/dev/null && echo "  ✓ coordinator healthy" || { echo "  ✗ not healthy — journalctl -u qbit-swap -n 40"; exit 1; }
REMOTE
echo "✓ deployed to $SERVER"
