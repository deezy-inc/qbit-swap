"""Validate p2mr derivation against golden vectors from qbit-core / the live node,
then derive a demo HTLC address. Run: python3 swaplib/selftest.py"""
import hashlib
from p2mr import (leaf_hash, single_leaf_root, p2mr_spk, p2mr_address,
                  single_key_leaf, htlc_leaf_qbit)

def h(b): return b.hex()

# 1) Golden vector straight from the live regtest node:
#    address desc mr(pk(d6d8..585f83)) -> scriptPubKey 5220 36836a9b..f86b9d
PUB = bytes.fromhex("d6d86f51b6de632fb0a9336acb3710c8c9f372577318af58881d28e0bc585f83")
EXPECT_ROOT = "36836a9b1f798efe3c80fd6f2c020e568c338e66325f43e8fc876a5e00f86b9d"
leaf = single_key_leaf(PUB)
root = single_leaf_root(leaf)
assert h(leaf) == "20" + PUB.hex() + "b3", h(leaf)
assert h(root) == EXPECT_ROOT, f"root mismatch: {h(root)} != {EXPECT_ROOT}"
assert p2mr_spk(leaf) == bytes.fromhex("5220" + EXPECT_ROOT)
print("[ok] single-key leaf root matches live node:", h(root))

# 2) bech32m round-trips the node's own address for that key
ADDR = "qbrt1zx6pk4xcl0x80u0yql4hjcqsw26xr8rnxxf05868usa49uq8cdwws9a930l"
assert p2mr_address(leaf, "qbrt") == ADDR, p2mr_address(leaf, "qbrt")
print("[ok] bech32m matches node address:", p2mr_address(leaf, "qbrt"))

# 3) Derive a demo HTLC (Qbit leg) address for two real regtest pubkeys
RECV = bytes.fromhex("bcd7245a5d380e596fea4574d60a25f7f66c92985984398bb354b7a3e6fb849f")
FUND = bytes.fromhex("1a3d9feff3f8ec82be87156b28d82141b0909aadc1b413a653c785135ed58e5b")
SECRET = b"\x11" * 32
H = hashlib.sha256(SECRET).digest()
LOCKTIME = 200
hl = htlc_leaf_qbit(H, RECV, FUND, LOCKTIME)
print("[--] HTLC leaf script  :", h(hl))
print("[--] HTLC merkle root  :", h(single_leaf_root(hl)))
print("[--] HTLC scriptPubKey :", h(p2mr_spk(hl)))
print("[>>] HTLC ADDRESS      :", p2mr_address(hl, "qbrt"))
