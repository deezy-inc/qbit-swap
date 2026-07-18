# Node patch — generic p2mr partial script-path signing

**File:** `0001-p2mr-generic-partial-signing.patch` (against `Qbit-Org/qbit@v1.0.0`, `src/script/sign.cpp`, +51/-3)

## Problem
Qbit's p2mr signer (`SignP2MR` → `BuildP2MRScriptSigningPlan` → `ParseP2MRScript`) only recognizes the
`pk(KEY)` and `multi_a` leaf templates. For any other leaf — e.g. an atomic-swap HTLC
(`OP_IF OP_SHA256 <H> OP_EQUALVERIFY <pk> OP_CHECKSIGPQC OP_ELSE <t> OP_CLTV OP_DROP <pk> OP_CHECKSIGPQC OP_ENDIF`) —
`ParseP2MRScript` returns false, so `signrawtransactionwithkey`, `signrawtransactionwithwallet`, and
`walletprocesspsbt` all produce an **empty witness**. A Qbit user therefore cannot sign an HTLC in
their own node; they need out-of-node signing tooling.

## Fix (mirrors Bitcoin Core taproot behavior)
Bitcoin Core happily emits *partial* tapscript signatures for scripts it cannot finalize itself,
leaving finalization to the PSBT workflow. This patch gives p2mr the same property **without**
touching finalization (which must stay template-aware — the node should not try to satisfy arbitrary
scripts):

- New `ExtractP2MRSignableKeys()` enumerates every pubkey in a `CHECKSIGPQC`/`CHECKSIGADD` position of
  an arbitrary leaf.
- When a leaf isn't a known template, `BuildP2MRScriptSigningPlan()` now builds a **non-finalizable**
  plan (`finalizable=false`, `complete=false`) that signs for every key the wallet holds.
- Those partial signatures land in `sigdata.p2mr_script_sigs` → serialized into the PSBT as
  `PSBT_IN_P2MR_SCRIPT_SIG` — exactly the "PSBT handoff to other signers" path that already exists in
  `SignP2MR` (it was simply unreachable for non-template leaves).
- Finalization of the branch witness (insert preimage/selector, set locktime) stays with the caller —
  the sidecar/coordinator — because no generic finalizer can satisfy an arbitrary script. This matches
  how Core leaves non-standard tapscript finalization to the user.

Counter-burning protection is preserved: `SignP2MR` still signs at most one partial plan per call.

## UX enabled
`walletprocesspsbt` (paste a PSBT into your own node) adds your SLH-DSA signature to the swap tx; a
thin finalizer completes and broadcasts it. The private key never leaves the user's wallet.

## Test plan (needs a full node build — do on a builder box or CI, not the 2-core testnet host)
1. Build patched `qbitd`; run on `qbrt` regtest.
2. Fund an HTLC p2mr address (see `swaplib/`).
3. Build the claim/refund tx as a PSBT carrying `PSBT_IN_P2MR_LEAF_SCRIPT` + witnessUtxo; run
   `walletprocesspsbt`.
4. Assert `decodepsbt` now shows a `p2mr_script_path_sigs` entry for the held key (pre-patch: absent).
5. Finalize with the sidecar (`swaplib` witness assembly), broadcast, confirm claim reveals the
   preimage and refund is CLTV-gated. Add a regression functional test under `test/functional/`.

## Suggested commit message
```
script/sign: emit partial p2mr script-path sigs for non-template leaves

The p2mr signer only recognised pk()/multi_a leaves, so signing any other
leaf (e.g. an HTLC) produced an empty witness across signrawtransactionwithkey,
signrawtransactionwithwallet and walletprocesspsbt.

Enumerate the CHECKSIGPQC/CHECKSIGADD keys of an arbitrary leaf and, when the
leaf is not a finalisable template, build a non-finalisable signing plan that
contributes a partial script-path signature for every held key. The signature
is handed off via PSBT (PSBT_IN_P2MR_SCRIPT_SIG); finalisation stays with the
caller, mirroring how Bitcoin Core emits partial tapscript signatures for
scripts it does not finalise. At most one partial plan is signed per call, so
PQC signature-counter burning on adversarial many-leaf PSBTs is unchanged.
```
