#!/usr/bin/env bash
# Bundle the web app to dist/app.js. Browser target -> esbuild honors the client library's "browser"
# field, swapping the Node WASM signer for signer.web.js (wasm embedded via SINGLE_FILE), so the
# output is a single self-contained module with no runtime fetches.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
npx esbuild src/main.js \
  --bundle --format=esm --platform=browser --target=es2022 \
  --loader:.wasm=binary \
  --outfile=dist/app.js "$@"
echo "built dist/app.js ($(wc -c < dist/app.js) bytes)"
