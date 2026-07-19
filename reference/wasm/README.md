# WASM SLH-DSA signer

The exotic part of the browser swap client — Qbit's post-quantum signing — compiled to WebAssembly.
Everything else the client needs (P2MR/BIP-341 sighash, tx serialization, bech32m, secp256k1/ECDSA
for the BTC leg) is ordinary and lives in JS; this is the piece that must be the vendored
`libbitcoinpqc` (SLH-DSA-SHA2-128s-bounded30) to match the chain byte-for-byte.

## Build
Needs Emscripten (`emsdk`). From this directory, with `emsdk_env.sh` sourced:
```sh
# compiles the vendored libbitcoinpqc (portable sha2 only; x86/arm SHA files excluded) + pqc_wasm.c
# -> pqc_signer.js (glue) + pqc_signer.wasm (~44 KB)
# see the emcc invocation used to produce these (documented in build.sh)
```
Exports: `pqc_keygen(random_data128 -> pk32, sk64)`, `pqc_sign(sk64, msg -> sig)`, `pqc_verify`,
and size accessors.

## Validation (`node test.js`)
- `keygen(0x20×128)` reproduces the golden public key `ff39b4ff…571e` (the p2mr witness-vector key).
- `pqc_sign` output is **byte-for-byte identical to the native `../pqcsign`** — SLH-DSA is
  deterministic, and native signatures are already node-accepted, so identical bytes ⇒ node-valid.
- `pqc_verify` accepts a valid signature and rejects a tampered one.

## End-to-end (`../wasm_claim_e2e.py`)
Builds a real p2mr HTLC claim, signs the P2MR sighash with **this WASM signer**, and broadcasts it to
a from-source build of the node — which accepts it and the claim reveals the preimage on-chain.
Confirms the browser-signing path works against the real node.
