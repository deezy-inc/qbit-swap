## p2mr: sign arbitrary (non-template) script-path leaves so a wallet can complete HTLC PSBTs

### Problem
p2mr script-path signing only handles two leaf templates — `pk(KEY)` and `multi_a`. For any other
leaf the node produces **no signature at all**, across `signrawtransactionwithkey`,
`signrawtransactionwithwallet`, and `walletprocesspsbt`. That blocks a whole class of legitimate
p2mr spends — most importantly **hash-time-locked contracts (HTLCs)**, the primitive behind
cross-chain atomic swaps:

```
OP_IF   OP_SHA256 <H> OP_EQUALVERIFY <recv_pubkey> OP_CHECKSIGPQC
OP_ELSE <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <refund_pubkey> OP_CHECKSIGPQC
OP_ENDIF
```

A Qbit user holding one of those keys cannot sign such a spend in their own node; today they must
compute the P2MR sighash and drive an SLH-DSA signer entirely outside the node.

### Fix
This lets the node contribute a **partial** script-path signature for any key it holds in an
arbitrary leaf, while leaving *finalization* untouched — mirroring how Bitcoin Core emits partial
tapscript signatures and defers completion to the PSBT workflow. The restriction lived in **two**
places, so both are addressed via one shared helper:

- **`script/p2mr.h` — `ExtractSignableKeys()`** (new): enumerate every pubkey in a
  `CHECKSIGPQC`/`CHECKSIGADD` position of a leaf. A superset of `MatchPK()`/`MatchMultiA()` that also
  covers non-template leaves. Templates are still matched exactly by `MatchPK`/`MatchMultiA` for
  *finalization*; this helper only locates signable keys.
- **`script/sign.cpp`** — when a leaf isn't a finalizable template, `BuildP2MRScriptSigningPlan()`
  now builds a **non-finalizable** plan (`finalizable=false`, `complete=false`) that signs for every
  held key. Those partial signatures flow into `PSBT_IN_P2MR_SCRIPT_SIG` via the existing "PSBT
  handoff" path in `SignP2MR` (previously unreachable for non-template leaves).
- **`wallet/scriptpubkeyman.cpp`** — `ExtractP2MRPubkeys()` (used to decide which held keys to offer
  when signing a foreign p2mr input via PSBT) now delegates to `p2mr::ExtractSignableKeys`, so the
  wallet offers its keys for arbitrary provided leaves rather than only `pk`/`multi_a`.

Finalization is intentionally unchanged: the node still only *finalizes* `pk`/`multi_a`; branch
selection and hash preimages for arbitrary scripts are supplied by the caller/finalizer. DoS posture
is unchanged — `SignP2MR` still signs at most one partial plan per input, so an adversarial many-leaf
PSBT cannot burn extra PQC signature counters.

### UX enabled
`walletprocesspsbt` (paste a PSBT into your own node) now adds your SLH-DSA signature to an HTLC
input; a thin finalizer completes and broadcasts it. The private key never leaves the user's wallet.

### Testing
- **Unit test** `p2mr_partial_signs_non_template_leaf` (`script_p2mr_tests.cpp`): builds an HTLC leaf
  with a receiver key and a refund key, gives the signer only the receiver key, and asserts the spend
  is not complete, that a partial signature is produced for the held key and **not** for the other,
  and that the partial signature is a valid SLH-DSA signature over the spend's P2MR sighash. Passes.
- **End-to-end** (`contrib/atomic-swap-demo/atomic_swap_demo.py`): a one-shot regtest BTC↔QBT atomic
  swap. Alice claims the QBT HTLC by pasting a PSBT into her own node (`walletprocesspsbt`) — which
  only signs with this change — revealing the preimage; Bob then claims the BTC side. Verified end to
  end against a from-source build of this branch.

### Backwards compatibility
Fully compatible: `pk`/`multi_a` signing and all finalization are byte-for-byte unchanged; the new
behavior only affects leaves that previously produced no signature.
