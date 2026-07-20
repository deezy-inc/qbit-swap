"""Qbit p2mr (pay-to-merkle-root) primitives + BTC<->QBT atomic-swap HTLC leaf.

Pure-Python, dependency-free. Verified against qbit-core (tag v1.0.0):
  - leaf hash  : ComputeP2MRLeafHash  (tagged hash "P2MRLeaf", leaf_version 0xc0)
  - merkle root: single leaf -> root == leaf hash (control block = {0xc1}, no internal key)
  - address    : bech32m(hrp, witver=2, root)   (qb mainnet / tq testnet4 / qbrt regtest)

The witness program IS the merkle root (untweaked, unlike taproot). A single-leaf spend
witness is [..stack.., leaf_script, control_block] with control_block == b"\\xc1".
"""
from __future__ import annotations
import hashlib
from typing import List

# ── opcodes we use ──────────────────────────────────────────────────────────
OP_IF, OP_ELSE, OP_ENDIF = 0x63, 0x67, 0x68
OP_DROP, OP_EQUALVERIFY = 0x75, 0x88
OP_SIZE = 0x82
OP_SHA256 = 0xA8
OP_CHECKLOCKTIMEVERIFY = 0xB1
OP_CHECKSIGPQC = 0xB3            # qbit's post-quantum CHECKSIG (old NOP4 slot)

P2MR_LEAF_VERSION = 0xC0
P2MR_CONTROL_SINGLE_LEAF = bytes([P2MR_LEAF_VERSION | 0x01])  # 0xc1


def tagged_hash(tag: str, msg: bytes) -> bytes:
    t = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(t + t + msg).digest()


def _compact_size(n: int) -> bytes:
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + n.to_bytes(2, "little")
    if n <= 0xFFFFFFFF:
        return b"\xfe" + n.to_bytes(4, "little")
    return b"\xff" + n.to_bytes(8, "little")


def _pushdata(data: bytes) -> bytes:
    n = len(data)
    if n < 0x4C:
        return bytes([n]) + data
    if n <= 0xFF:
        return b"\x4c" + bytes([n]) + data
    if n <= 0xFFFF:
        return b"\x4d" + n.to_bytes(2, "little") + data
    return b"\x4e" + n.to_bytes(4, "little") + data


def _scriptnum(n: int) -> bytes:
    """Minimal CScriptNum encoding (used for the CLTV locktime operand)."""
    if n == 0:
        return b""
    neg = n < 0
    absn = -n if neg else n
    out = bytearray()
    while absn:
        out.append(absn & 0xFF)
        absn >>= 8
    if out[-1] & 0x80:
        out.append(0x80 if neg else 0x00)
    elif neg:
        out[-1] |= 0x80
    return bytes(out)


def leaf_hash(script: bytes, leaf_version: int = P2MR_LEAF_VERSION) -> bytes:
    return tagged_hash("P2MRLeaf", bytes([leaf_version]) + _compact_size(len(script)) + script)


def single_leaf_root(script: bytes) -> bytes:
    """Merkle root for a single-leaf tree == the leaf hash itself."""
    return leaf_hash(script)


# ── bech32 / bech32m (BIP-173 / BIP-350) ────────────────────────────────────
_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32M_CONST = 0x2BC830A3


def _polymod(values: List[int]) -> int:
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def _hrp_expand(hrp: str) -> List[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _convertbits(data: bytes, frm: int, to: int, pad: bool = True) -> List[int]:
    acc, bits, ret, maxv = 0, 0, [], (1 << to) - 1
    for b in data:
        acc = (acc << frm) | b
        bits += frm
        while bits >= to:
            bits -= to
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (to - bits)) & maxv)
    return ret


def encode_segwit(hrp: str, witver: int, program: bytes) -> str:
    data = [witver] + _convertbits(program, 8, 5)
    const = _BECH32M_CONST if witver != 0 else 1
    values = _hrp_expand(hrp) + data
    polymod = _polymod(values + [0, 0, 0, 0, 0, 0]) ^ const
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_CHARSET[d] for d in data + checksum)


# ── p2mr address from a leaf script ─────────────────────────────────────────
def p2mr_address(script: bytes, hrp: str) -> str:
    return encode_segwit(hrp, 2, single_leaf_root(script))


def p2mr_spk(script: bytes) -> bytes:
    """scriptPubKey = OP_2 <32-byte root> = 0x52 0x20 <root>."""
    return bytes([0x52, 0x20]) + single_leaf_root(script)


# ── the atomic-swap HTLC leaf (Qbit leg) ────────────────────────────────────
def htlc_leaf_qbit(hash_h: bytes, receiver_pqc_pubkey: bytes, funder_pqc_pubkey: bytes,
                   locktime: int) -> bytes:
    """
    OP_IF   OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <receiver_pqc> OP_CHECKSIGPQC   # claim (reveal preimage)
    OP_ELSE <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <funder_pqc> OP_CHECKSIGPQC   # refund
    OP_ENDIF

    OP_SIZE 32 OP_EQUALVERIFY pins the preimage to exactly 32 bytes so the same secret satisfies both
    chains' hashlocks identically (no differently-sized preimage that only works on one leg).
    """
    assert len(hash_h) == 32
    assert len(receiver_pqc_pubkey) == 32 and len(funder_pqc_pubkey) == 32
    s = bytearray()
    s.append(OP_IF)
    s.append(OP_SIZE); s += _pushdata(_scriptnum(32)); s.append(OP_EQUALVERIFY)
    s.append(OP_SHA256); s += _pushdata(hash_h); s.append(OP_EQUALVERIFY)
    s += _pushdata(receiver_pqc_pubkey); s.append(OP_CHECKSIGPQC)
    s.append(OP_ELSE)
    s += _pushdata(_scriptnum(locktime)); s.append(OP_CHECKLOCKTIMEVERIFY); s.append(OP_DROP)
    s += _pushdata(funder_pqc_pubkey); s.append(OP_CHECKSIGPQC)
    s.append(OP_ENDIF)
    return bytes(s)


def single_key_leaf(pqc_pubkey: bytes) -> bytes:
    """The plain pk(pqc(..)) leaf: 0x20 <pubkey> 0xb3  (matches wallet mr(pk(..)) addresses)."""
    assert len(pqc_pubkey) == 32
    return _pushdata(pqc_pubkey) + bytes([OP_CHECKSIGPQC])


# ── tiny CLI: emit HTLC leaf hex + address for orchestration ─────────────────
if __name__ == "__main__":
    import sys, json
    # usage: p2mr.py htlc <H_hex> <recv_pub_hex> <fund_pub_hex> <locktime> <hrp>
    if len(sys.argv) >= 2 and sys.argv[1] == "htlc":
        H = bytes.fromhex(sys.argv[2]); recv = bytes.fromhex(sys.argv[3])
        fund = bytes.fromhex(sys.argv[4]); lt = int(sys.argv[5]); hrp = sys.argv[6]
        leaf = htlc_leaf_qbit(H, recv, fund, lt)
        print(json.dumps({
            "leaf": leaf.hex(),
            "root": single_leaf_root(leaf).hex(),
            "spk": p2mr_spk(leaf).hex(),
            "address": p2mr_address(leaf, hrp),
            "control": P2MR_CONTROL_SINGLE_LEAF.hex(),
        }))
