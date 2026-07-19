"""Re-derive a wallet's SLH-DSA signing key from its exported xprv (`listdescriptors true`).

This is what lets the sidecar "borrow" the key from the user's own local node wallet: given the
active descriptor `mr(pk(pqc(<xprv>/87h/1h/0h/0/*)))`, the key for external index `pos` is
    seed   = BIP32(xprv, 87h/1h/0h/0/pos)                # 32-byte private scalar
    okm    = HKDF-SHA256(salt="qbit-sphincs-v1", ikm=seed,
                         info="qbit/sphincs+/1"||LE32(0)||LE32(0)||LE32(pos))  -> 128 bytes
    (pk,sk)= slh_dsa_keygen(okm)                          # via the pqctool helper
matching qbit-core's DerivePQCKey exactly. Verified against a live wallet address.
"""
import hashlib, hmac, subprocess, os

PQCTOOL = os.path.join(os.path.dirname(__file__), "pqctool")

# ── secp256k1 (minimal, for BIP32) ──────────────────────────────────────────
_P = 2**256 - 2**32 - 977
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
_Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

def _inv(a, m): return pow(a, m - 2, m)
def _add(p, q):
    if p is None: return q
    if q is None: return p
    if p[0] == q[0] and (p[1] + q[1]) % _P == 0: return None
    if p == q:
        l = (3 * p[0] * p[0]) * _inv(2 * p[1], _P) % _P
    else:
        l = (q[1] - p[1]) * _inv((q[0] - p[0]) % _P, _P) % _P
    x = (l * l - p[0] - q[0]) % _P
    return (x, (l * (p[0] - x) - p[1]) % _P)
def _mul(k, p=(_Gx, _Gy)):
    r = None
    while k:
        if k & 1: r = _add(r, p)
        p = _add(p, p); k >>= 1
    return r
def _ser_p(k):  # compressed pubkey of scalar k
    x, y = _mul(k)
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")

# ── base58check ─────────────────────────────────────────────────────────────
_A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def _b58decode(s):
    n = 0
    for c in s: n = n * 58 + _A.index(c)
    full = n.to_bytes((n.bit_length() + 7) // 8, "big")
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + full

def _decode_xprv(xprv):
    raw = _b58decode(xprv)
    payload, chk = raw[:-4], raw[-4:]
    assert hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] == chk, "bad xprv checksum"
    # version(4) depth(1) parent_fp(4) childnum(4) chaincode(32) keydata(33=0x00||priv)
    chaincode = payload[13:45]
    assert payload[45] == 0x00
    priv = int.from_bytes(payload[46:78], "big")
    return priv, chaincode

# ── BIP32 CKDpriv ───────────────────────────────────────────────────────────
_H = 0x80000000
def _ckd(k, c, i):
    if i & _H:
        data = b"\x00" + k.to_bytes(32, "big") + i.to_bytes(4, "big")
    else:
        data = _ser_p(k) + i.to_bytes(4, "big")
    I = hmac.new(c, data, hashlib.sha512).digest()
    ki = (int.from_bytes(I[:32], "big") + k) % _N
    return ki, I[32:]

def _derive_path(xprv, path):
    k, c = _decode_xprv(xprv)
    for i in path:
        k, c = _ckd(k, c, i)
    return k.to_bytes(32, "big")

# ── qbit DerivePQCKey (HKDF-SHA256 expand + slh_dsa_keygen) ──────────────────
_SALT = b"qbit-sphincs-v1"
_INFO = b"qbit/sphincs+/1"
def _hkdf(seed, account, change, index, length=128):
    prk = hmac.new(_SALT, seed, hashlib.sha256).digest()
    info = _INFO + account.to_bytes(4, "little") + change.to_bytes(4, "little") + index.to_bytes(4, "little")
    okm, t, ctr = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([ctr]), hashlib.sha256).digest()
        okm += t; ctr += 1
    return okm[:length]

def derive_wallet_key(xprv, pos, account_path=(87 | _H, 1 | _H, 0 | _H, 0)):
    """Return (pubkey_hex, seckey_hex) for external-chain index `pos` of a qbit descriptor wallet."""
    seed = _derive_path(xprv, list(account_path) + [pos])
    okm = _hkdf(seed, 0, 0, pos)
    out = subprocess.run([PQCTOOL, "keygen", okm.hex()], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"pqctool keygen: {out.stderr.strip()}")
    d = dict(line.split() for line in out.stdout.strip().splitlines())
    return d["pk"], d["sk"]


if __name__ == "__main__":
    # Validate against the live lab wallet: index 0 must be the known pubkey.
    XPRV = "qrpvV1brS3WRoVwgSjtqNhQXzegTzcNunix3JuS2zMK1jGeddFvSULvgHB5DXcC4c6fq2w9prcuhj3QwYLDwXAkikEhMvZSc2MBL1nPuFqVwJNG"
    EXPECT0 = "d6d86f51b6de632fb0a9336acb3710c8c9f372577318af58881d28e0bc585f83"
    pk, sk = derive_wallet_key(XPRV, 0)
    print(f"index 0 pubkey: {pk}")
    print(f"[{'ok' if pk == EXPECT0 else 'FAIL'}] matches live wallet address (expect {EXPECT0[:16]}..)")
