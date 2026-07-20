"""Bitcoin leg of the atomic swap: standard P2WSH HTLC + BIP143 signing.

Self-contained (pure-Python secp256k1 / ECDSA via keyderiv's field math), so the demo needs only a
regtest bitcoind for chain state + broadcast — no wallet-side script solving.
"""
import hashlib, hmac
from keyderiv import _N, _mul, _inv, _ser_p        # secp256k1 helpers
from p2mr import encode_segwit, _pushdata, _scriptnum
from txcodec import cs_enc

OP_IF, OP_ELSE, OP_ENDIF, OP_DROP = 0x63, 0x67, 0x68, 0x75
OP_SIZE = 0x82
OP_EQUALVERIFY, OP_SHA256 = 0x88, 0xA8
OP_CHECKSIG, OP_CHECKLOCKTIMEVERIFY = 0xAC, 0xB1

def _dsha(b): return hashlib.sha256(hashlib.sha256(b).digest()).digest()
def pubkey(priv_int): return _ser_p(priv_int)   # 33-byte compressed

# ── ECDSA (RFC6979 deterministic, low-S) ────────────────────────────────────
def _rfc6979_k(priv, z):
    x = priv.to_bytes(32, "big"); h1 = z.to_bytes(32, "big")
    v = b"\x01" * 32; k = b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + h1, hashlib.sha256).digest(); v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + h1, hashlib.sha256).digest(); v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        cand = int.from_bytes(v, "big")
        if 1 <= cand < _N: return cand
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest(); v = hmac.new(k, v, hashlib.sha256).digest()

def _der(r, s):
    def enc(x):
        b = x.to_bytes((x.bit_length() + 7) // 8 or 1, "big")
        return (b"\x00" + b) if b[0] & 0x80 else b
    rb, sb = enc(r), enc(s)
    return b"\x30" + bytes([len(rb) + len(sb) + 4]) + b"\x02" + bytes([len(rb)]) + rb + b"\x02" + bytes([len(sb)]) + sb

def ecdsa_sign(priv, z32: bytes) -> bytes:
    z = int.from_bytes(z32, "big")
    k = _rfc6979_k(priv, z)
    R = _mul(k); r = R[0] % _N
    s = (_inv(k, _N) * (z + r * priv)) % _N
    if s > _N // 2: s = _N - s
    return _der(r, s) + b"\x01"    # SIGHASH_ALL

# ── HTLC witnessScript + P2WSH address ──────────────────────────────────────
def htlc_witness_script(hash_h: bytes, claim_pub: bytes, refund_pub: bytes, locktime: int) -> bytes:
    s = bytearray()
    s.append(OP_IF)
    s.append(OP_SIZE); s += _pushdata(_scriptnum(32)); s.append(OP_EQUALVERIFY)   # pin preimage to 32 bytes
    s.append(OP_SHA256); s += _pushdata(hash_h); s.append(OP_EQUALVERIFY)
    s += _pushdata(claim_pub); s.append(OP_CHECKSIG)
    s.append(OP_ELSE)
    s += _pushdata(_scriptnum(locktime)); s.append(OP_CHECKLOCKTIMEVERIFY); s.append(OP_DROP)
    s += _pushdata(refund_pub); s.append(OP_CHECKSIG)
    s.append(OP_ENDIF)
    return bytes(s)

def p2wsh_spk(ws: bytes) -> bytes:
    return bytes([0x00, 0x20]) + hashlib.sha256(ws).digest()

def p2wsh_address(ws: bytes, hrp="bcrt") -> str:
    return encode_segwit(hrp, 0, hashlib.sha256(ws).digest())

# ── BIP143 sighash + spends ─────────────────────────────────────────────────
def bip143_sighash(version, vin, vout, in_idx, script_code: bytes, amount_sats, locktime, hashtype=1):
    hash_prevouts = _dsha(b"".join(txid + v.to_bytes(4, "little") for txid, v, _ in vin))
    hash_sequence = _dsha(b"".join(seq.to_bytes(4, "little") for _, _, seq in vin))
    hash_outputs = _dsha(b"".join(val.to_bytes(8, "little") + cs_enc(len(spk)) + spk for val, spk in vout))
    txid, v, seq = vin[in_idx]
    pre = (version.to_bytes(4, "little") + hash_prevouts + hash_sequence +
           txid + v.to_bytes(4, "little") + cs_enc(len(script_code)) + script_code +
           amount_sats.to_bytes(8, "little") + seq.to_bytes(4, "little") + hash_outputs +
           locktime.to_bytes(4, "little") + hashtype.to_bytes(4, "little"))
    return _dsha(pre)

def _serialize(version, vin, vout, witnesses, locktime):
    o = version.to_bytes(4, "little") + b"\x00\x01" + cs_enc(len(vin))
    for txid, v, seq in vin:
        o += txid + v.to_bytes(4, "little") + b"\x00" + seq.to_bytes(4, "little")   # empty scriptSig
    o += cs_enc(len(vout))
    for val, spk in vout:
        o += val.to_bytes(8, "little") + cs_enc(len(spk)) + spk
    for w in witnesses:
        o += cs_enc(len(w))
        for item in w:
            o += cs_enc(len(item)) + item
    return (o + locktime.to_bytes(4, "little")).hex()

def spend(prev_txid_display, vout_n, amount_sats, ws, dest_spk, out_val, *, branch, priv,
          preimage=None, locktime=0, sequence=0xffffffff, version=2):
    txid_le = bytes.fromhex(prev_txid_display)[::-1]
    vin = [(txid_le, vout_n, sequence)]
    vout = [(out_val, dest_spk)]
    z = bip143_sighash(version, vin, vout, 0, ws, amount_sats, locktime)
    sig = ecdsa_sign(priv, z)
    if branch == "claim":
        witness = [sig, preimage, b"\x01", ws]
    else:
        witness = [sig, b"", ws]
    return _serialize(version, vin, vout, [witness], locktime)
