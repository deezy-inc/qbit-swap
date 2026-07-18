"""P2MR (BIP341/taproot-style) script-path signature hash for Qbit.

Verified byte-for-byte against qbit-core: SignatureHashSchnorrCommon with tag "P2MRSighash",
SigVersion::P2MR (ext_flag=1, key_version=0). This is the message OP_CHECKSIGPQC verifies, so a
valid SLH-DSA signature over it (produced by libbitcoinpqc with the leaf's key) spends the leaf.

We compute this ourselves because the node's wallet/PSBT signer only signs pk()/multi_a leaf
templates (script/sign.cpp ParseP2MRScript) — it will NOT sign an HTLC (OP_IF/hashlock/CLTV) leaf.
So HTLC claim/refund signing lives in our own signer, not stock qbitd.
"""
import hashlib
from p2mr import tagged_hash, _compact_size, single_leaf_root

SIGHASH_DEFAULT = 0x00

def _sha(b): return hashlib.sha256(b).digest()

def _ser_outpoint(txid_le: bytes, vout: int) -> bytes:
    return txid_le + vout.to_bytes(4, "little")

def _ser_output(value: int, spk: bytes) -> bytes:
    return value.to_bytes(8, "little") + _compact_size(len(spk)) + spk

def p2mr_sighash(*, version: int, locktime: int,
                 vin,               # list of (txid_le: bytes, vout: int, sequence: int)
                 spent_outputs,     # list of (amount: int, spk: bytes) aligned to vin
                 vout,              # list of (value: int, spk: bytes)
                 input_index: int,
                 leaf_script: bytes,
                 hash_type: int = SIGHASH_DEFAULT,
                 leaf_version: int = 0xC0,
                 codeseparator_pos: int = 0xFFFFFFFF) -> bytes:
    assert hash_type == SIGHASH_DEFAULT, "only SIGHASH_DEFAULT implemented (what the coordinator uses)"

    sha_prevouts = _sha(b"".join(_ser_outpoint(t, v) for t, v, _ in vin))
    sha_amounts  = _sha(b"".join(a.to_bytes(8, "little") for a, _ in spent_outputs))
    sha_spks     = _sha(b"".join(_compact_size(len(s)) + s for _, s in spent_outputs))
    sha_seqs     = _sha(b"".join(seq.to_bytes(4, "little") for _, _, seq in vin))
    sha_outputs  = _sha(b"".join(_ser_output(val, s) for val, s in vout))

    tapleaf_hash = single_leaf_root(leaf_script)  # ComputeP2MRLeafHash(0xc0, leaf); single leaf

    msg = b""
    msg += bytes([0x00])                       # epoch
    msg += bytes([hash_type])                  # hash type
    msg += version.to_bytes(4, "little")
    msg += locktime.to_bytes(4, "little")
    msg += sha_prevouts + sha_amounts + sha_spks + sha_seqs
    msg += sha_outputs                          # SIGHASH_ALL (default)
    msg += bytes([0x02])                        # spend_type = ext_flag(1)<<1 + annex(0)
    msg += input_index.to_bytes(4, "little")
    # script path (ext_flag=1):
    msg += tapleaf_hash
    msg += bytes([0x00])                        # key_version
    msg += codeseparator_pos.to_bytes(4, "little")

    return tagged_hash("P2MRSighash", msg)


# ── validate against qbit-core golden witness vectors ───────────────────────
if __name__ == "__main__":
    import json, sys
    sys.path.insert(0, ".")
    from txcodec import parse_tx  # reuse the segwit tx codec

    vecs = json.load(open("vectors.json"))
    ok = 0
    for v in vecs:
        if v.get("hashType") != "00":
            print(f"[skip] {v['name']} (hashType {v['hashType']} not implemented)"); continue
        t = parse_tx(v["spendTx"])
        vin = [(txid, vout, seq) for (txid, vout, _s, seq) in t["vin"]]
        spent = [(o["amount"], bytes.fromhex(o["scriptPubKey"])) for o in v["spentOutputs"]]
        vout = [(val, spk) for (val, spk) in t["vout"]]
        got = p2mr_sighash(version=t["version"], locktime=t["locktime"], vin=vin,
                           spent_outputs=spent, vout=vout, input_index=v["inputIndex"],
                           leaf_script=bytes.fromhex(v["leafScript"]))
        exp = v["p2mrSighash"]
        # also validate leaf hash
        lh_ok = single_leaf_root(bytes.fromhex(v["leafScript"])).hex() == v["leafHash"]
        match = got.hex() == exp
        print(f"[{'ok' if match else 'FAIL'}] {v['name']}: sighash {got.hex()[:20]}.. (leafHash {'ok' if lh_ok else 'FAIL'})")
        if not match:
            print(f"        expected {exp}")
        ok += match and lh_ok
    print(f"\n{ok}/{sum(1 for v in vecs if v.get('hashType')=='00')} default-sighash vectors validated")
