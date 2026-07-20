#!/usr/bin/env bash
# Bundle the web app to dist/app.js. Browser target -> esbuild honors the client library's "browser"
# field, swapping the Node WASM signer for signer.web.js (wasm embedded via SINGLE_FILE), so the
# output is a single self-contained module with no runtime fetches.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

# @qbit-swap/client is a local `file:../client` dependency. npm copies it into node_modules on install
# and will NOT re-copy on a later `npm install` when the version is unchanged — so the bundled copy can
# silently go stale and drift from the coordinator's HTLC derivation (a mismatch that halts every swap
# at the client's verifyHtlc check). Refresh it from source on every build so that can never happen.
# Transitive deps (noble) still resolve from webapp/node_modules since the copy lives under it.
DEST="node_modules/@qbit-swap/client"
rm -rf "$DEST"; mkdir -p node_modules/@qbit-swap
cp -R ../client "$DEST"
rm -rf "$DEST/node_modules"
npx esbuild src/main.js \
  --bundle --format=esm --platform=browser --target=es2022 \
  --loader:.wasm=binary \
  --outfile=dist/app.js "$@"
echo "built dist/app.js ($(wc -c < dist/app.js) bytes)"
