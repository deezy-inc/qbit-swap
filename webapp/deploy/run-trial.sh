#!/usr/bin/env bash
# Launch the trial stack. Put your regtest lab's env in deploy/lab.env (gitignored) — e.g.
# QBIT_SSH_HOST / QBIT_CLI / BTC_SSH_HOST / BTC_CLI (see chain.js), PUBLIC_URL, DEV_CONFS_CAP.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/lab.env ] && { set -a; . deploy/lab.env; set +a; }
exec node deploy/trial.js
