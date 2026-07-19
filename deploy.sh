#!/usr/bin/env bash
# Deploy the local qbit-otc working tree to the live swap server (rsync → npm install → build →
# restart the coordinator). Run from the repo root on the VM that holds the code:
#
#   ./deploy.sh                          # deploy to the default server (tailnet)
#   SERVER=ubuntu@REDACTED-IP ./deploy.sh
#
# The coordinator restart drops live SSE connections briefly; in-flight swaps survive via COORD_DB.
set -euo pipefail

SERVER="${SERVER:-ubuntu@swap-server}"      # tailnet MagicDNS host (or ubuntu@<tailscale-ip>)
REMOTE="${REMOTE:-/home/ubuntu/qbit-otc}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "→ syncing $HERE → $SERVER:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude 'webapp/dist' \
  --exclude '*.log' --exclude 'webapp/deploy/lab.env' \
  "$HERE"/ "$SERVER:$REMOTE"/

echo "→ install deps + build + restart on $SERVER"
ssh "$SERVER" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /home/ubuntu/qbit-otc
for pkg in client coordinator webapp; do ( cd "$pkg" && npm install --no-audit --no-fund >/dev/null ); done
( cd webapp && bash build.sh )
sudo systemctl restart qbit-swap
sleep 4
curl -fsS --max-time 8 http://127.0.0.1:8787/health >/dev/null && echo "  ✓ coordinator healthy" || { echo "  ✗ coordinator not healthy — check: journalctl -u qbit-swap -n 40"; exit 1; }
REMOTE
echo "✓ deployed to $SERVER — https://swap-server.scrubbed.ts.net"
