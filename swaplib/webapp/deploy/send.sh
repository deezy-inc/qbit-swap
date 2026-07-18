#!/usr/bin/env bash
# TRIAL helper: send regtest coins to a swap's deposit address, from the desk's throwaway node wallet.
# Auto-detects the chain from the address prefix (bcrt1 = BTC, qbrt1 = QBT). The trial's background
# miner confirms it within a few seconds. Usage:  send.sh <address> [amount]   (set LAB_SSH_HOST for a
# remote regtest lab; defaults to localhost).
set -euo pipefail
ADDR="${1:?usage: send.sh <address> [amount]}"
AMT="${2:-}"
NODE="${LAB_SSH_HOST:-localhost}"
case "$ADDR" in
  bcrt1*) AMT="${AMT:-1}"
    ssh "$NODE" "docker exec btcregtest bitcoin-cli -regtest -rpcuser=lab -rpcpassword=lab -rpcwallet=alice sendtoaddress $ADDR $AMT" ;;
  qbrt1*) AMT="${AMT:-5}"
    ssh "$NODE" "docker exec qbitbuild /src/build/bin/qbit-cli -regtest -datadir=/root/qbrtp -rpcuser=lab -rpcpassword=lab -rpcwallet=bob sendtoaddress $ADDR $AMT" ;;
  *) echo "unrecognized address prefix: $ADDR" >&2; exit 1 ;;
esac
