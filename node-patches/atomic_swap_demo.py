#!/usr/bin/env python3
"""
BTC <-> QBT atomic-swap demo + failure-mode (recovery) demos, end to end, on regtest.

It proves the value of the p2mr generic-partial-signing change: the Qbit side of the swap is an HTLC
p2mr leaf, and the parties sign it by pasting a PSBT into their *own Qbit node* (`walletprocesspsbt`).
That only produces a signature with this patch; without it the node returns an empty witness and the
swap can't be completed (or refunded) inside the node.

Scenarios (pick one on the command line; default `swap`):
  swap          Happy path -- both parties execute; the swap completes atomically.
  bob-aborts    Alice funds BTC, Bob never funds QBT -> Alice reclaims her BTC after the timeout.
  alice-aborts  Both fund, Alice never claims -> Bob reclaims his QBT (via walletprocesspsbt on the
                REFUND branch) and Alice reclaims her BTC. The failed swap costs nobody anything.

The recovery scenarios also show the patch signs BOTH HTLC branches (claim = receiver key, refund =
funder key), and that a refund is rejected before its CLTV timeout and accepted after.

Set up the two regtest nodes with ./setup-regtest.sh (see README.md), then export the CLIs it prints:
  QBIT_CLI="<path>/qbit-cli -regtest -datadir=<dir> -rpcuser=lab -rpcpassword=lab"
  BTC_CLI="docker exec btcregtest bitcoin-cli -regtest -rpcuser=lab -rpcpassword=lab"
  python3 atomic_swap_demo.py [swap|bob-aborts|alice-aborts]
"""
import os, sys, json, shlex, hashlib, hmac, base64, subprocess

# ─────────────────────────── node CLIs (override via env) ───────────────────
# Defaults match setup-regtest.sh; override QBIT_CLI / BTC_CLI to point at your own nodes.
_DEFAULT_QBIT_DATADIR = os.path.expanduser("~/.qbit-swap-regtest")
QBIT_CLI = os.environ.get("QBIT_CLI", f"./build/bin/qbit-cli -regtest -datadir={_DEFAULT_QBIT_DATADIR} -rpcuser=lab -rpcpassword=lab")
BTC_CLI  = os.environ.get("BTC_CLI",  "docker exec btcregtest bitcoin-cli -regtest -rpcuser=lab -rpcpassword=lab")
QBIT_HRP, BTC_HRP = "qbrt", "bcrt"

def _run(base, wallet, args):
    a = ["true" if x is True else "false" if x is False else str(x) for x in args]
    cmd = base + (f" -rpcwallet={wallet}" if wallet else "") + " " + " ".join(shlex.quote(x) for x in a)
    r = subprocess.run(shlex.split(cmd), capture_output=True, text=True)
    if r.returncode: raise RuntimeError(f"{args[0]}: {r.stderr.strip()}")
    s = r.stdout.strip()
    try: return json.loads(s)
    except json.JSONDecodeError: return s

def q(*a, w=None): return _run(QBIT_CLI, w, a)
def b(*a, w=None): return _run(BTC_CLI, w, a)

# ─────────────────────────── crypto primitives ─────────────────────────────
def sha256(x): return hashlib.sha256(x).digest()
def dsha(x): return sha256(sha256(x))

# secp256k1 (for the Bitcoin leg's ECDSA -- Alice/Bob hold these HTLC keys directly)
_P = 2**256 - 2**32 - 977
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
      0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def _inv(a, m): return pow(a, m - 2, m)
def _add(p, qq):
    if p is None: return qq
    if qq is None: return p
    if p[0] == qq[0] and (p[1] + qq[1]) % _P == 0: return None
    l = ((3*p[0]*p[0]) * _inv(2*p[1], _P) if p == qq else (qq[1]-p[1]) * _inv((qq[0]-p[0]) % _P, _P)) % _P
    x = (l*l - p[0] - qq[0]) % _P
    return (x, (l*(p[0]-x) - p[1]) % _P)
def _mul(k, p=_G):
    r = None
    while k:
        if k & 1: r = _add(r, p)
        p = _add(p, p); k >>= 1
    return r
def compressed_pub(priv):
    x, y = _mul(priv)
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")
def _rfc6979(priv, z):
    x = priv.to_bytes(32, "big"); h1 = z.to_bytes(32, "big")
    v = b"\x01"*32; k = b"\x00"*32
    k = hmac.new(k, v+b"\x00"+x+h1, hashlib.sha256).digest(); v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v+b"\x01"+x+h1, hashlib.sha256).digest(); v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest(); c = int.from_bytes(v, "big")
        if 1 <= c < _N: return c
        k = hmac.new(k, v+b"\x00", hashlib.sha256).digest(); v = hmac.new(k, v, hashlib.sha256).digest()
def ecdsa_sign(priv, z32):
    z = int.from_bytes(z32, "big"); k = _rfc6979(priv, z)
    r = _mul(k)[0] % _N; s = (_inv(k, _N)*(z + r*priv)) % _N
    if s > _N//2: s = _N - s
    def enc(v):
        vb = v.to_bytes((v.bit_length()+7)//8 or 1, "big"); return (b"\x00"+vb) if vb[0] & 0x80 else vb
    rb, sb = enc(r), enc(s)
    return b"\x30"+bytes([len(rb)+len(sb)+4])+b"\x02"+bytes([len(rb)])+rb+b"\x02"+bytes([len(sb)])+sb+b"\x01"

# ─────────────────────────── script / tx encoding ──────────────────────────
def cs(n):
    if n < 0xfd: return bytes([n])
    if n <= 0xffff: return b"\xfd"+n.to_bytes(2, "little")
    if n <= 0xffffffff: return b"\xfe"+n.to_bytes(4, "little")
    return b"\xff"+n.to_bytes(8, "little")
def push(d):
    n = len(d)
    if n < 0x4c: return bytes([n])+d
    if n <= 0xff: return b"\x4c"+bytes([n])+d
    if n <= 0xffff: return b"\x4d"+n.to_bytes(2, "little")+d
    return b"\x4e"+n.to_bytes(4, "little")+d
def snum(n):
    if n == 0: return b""
    out, a = bytearray(), abs(n)
    while a: out.append(a & 0xff); a >>= 8
    if out[-1] & 0x80: out.append(0x80 if n < 0 else 0x00)
    elif n < 0: out[-1] |= 0x80
    return bytes(out)

OP = dict(IF=0x63, ELSE=0x67, ENDIF=0x68, DROP=0x75, EQUALVERIFY=0x88, SHA256=0xA8,
          CHECKSIG=0xAC, CLTV=0xB1, CHECKSIGPQC=0xB3)

# bech32 / bech32m
_CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def _pm(vals):
    g = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]; c = 1
    for v in vals:
        t = c >> 25; c = ((c & 0x1FFFFFF) << 5) ^ v
        for i in range(5): c ^= g[i] if ((t >> i) & 1) else 0
    return c
def _conv(data):
    acc = bits = 0; out = []
    for x in data:
        acc = (acc << 8) | x; bits += 8
        while bits >= 5: bits -= 5; out.append((acc >> bits) & 31)
    if bits: out.append((acc << (5-bits)) & 31)
    return out
def segwit_addr(hrp, ver, prog):
    data = [ver] + _conv(prog)
    const = 0x2bc830a3 if ver else 1
    hx = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    pmod = _pm(hx + data + [0]*6) ^ const
    chk = [(pmod >> 5*(5-i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_CH[d] for d in data + chk)

# ─────────────────────────── p2mr (Qbit) HTLC ──────────────────────────────
def tagged(tag, msg): t = sha256(tag.encode()); return sha256(t + t + msg)
def p2mr_leaf_hash(script): return tagged("P2MRLeaf", b"\xc0" + cs(len(script)) + script)
def qbit_htlc_leaf(H, claim_pub, refund_pub, locktime):
    s = bytearray([OP["IF"], OP["SHA256"]]); s += push(H); s.append(OP["EQUALVERIFY"])
    s += push(claim_pub); s.append(OP["CHECKSIGPQC"]); s.append(OP["ELSE"])
    s += push(snum(locktime)); s += bytes([OP["CLTV"], OP["DROP"]])
    s += push(refund_pub); s.append(OP["CHECKSIGPQC"]); s.append(OP["ENDIF"])
    return bytes(s)
def qbit_htlc_addr(leaf): return segwit_addr(QBIT_HRP, 2, p2mr_leaf_hash(leaf))
def qbit_htlc_spk(leaf): return bytes([0x52, 0x20]) + p2mr_leaf_hash(leaf)

# ─────────────────────────── Bitcoin P2WSH HTLC ────────────────────────────
def btc_htlc_ws(H, claim_pub, refund_pub, locktime):
    s = bytearray([OP["IF"], OP["SHA256"]]); s += push(H); s.append(OP["EQUALVERIFY"])
    s += push(claim_pub); s.append(OP["CHECKSIG"]); s.append(OP["ELSE"])
    s += push(snum(locktime)); s += bytes([OP["CLTV"], OP["DROP"]])
    s += push(refund_pub); s.append(OP["CHECKSIG"]); s.append(OP["ENDIF"])
    return bytes(s)
def btc_p2wsh_spk(ws): return bytes([0x00, 0x20]) + sha256(ws)
def btc_p2wsh_addr(ws): return segwit_addr(BTC_HRP, 0, sha256(ws))
def btc_bip143(ver, vin, vout, i, code, amt, lock, ht=1):
    hp = dsha(b"".join(t + v.to_bytes(4, "little") for t, v, _ in vin))
    hs = dsha(b"".join(sq.to_bytes(4, "little") for _, _, sq in vin))
    ho = dsha(b"".join(val.to_bytes(8, "little") + cs(len(spk)) + spk for val, spk in vout))
    t, v, sq = vin[i]
    return dsha(ver.to_bytes(4, "little") + hp + hs + t + v.to_bytes(4, "little") + cs(len(code)) + code +
                amt.to_bytes(8, "little") + sq.to_bytes(4, "little") + ho + lock.to_bytes(4, "little") + ht.to_bytes(4, "little"))
def attach_witness(unsigned_hex, witnesses):
    """Turn a legacy (non-witness) tx hex into a segwit tx by inserting the marker/flag and appending
    the witness, preserving every non-witness byte exactly (so it still matches the signed sighash)."""
    v, body, lock = unsigned_hex[:8], unsigned_hex[8:-8], unsigned_hex[-8:]
    wit = "".join(cs(len(w)).hex() + "".join(cs(len(it)).hex() + it.hex() for it in w) for w in witnesses)
    return v + "0001" + body + wit + lock

def ser_segwit(ver, vin, vout, wits, lock):
    o = ver.to_bytes(4, "little") + b"\x00\x01" + cs(len(vin))
    for t, v, sq in vin: o += t + v.to_bytes(4, "little") + b"\x00" + sq.to_bytes(4, "little")
    o += cs(len(vout))
    for val, spk in vout: o += val.to_bytes(8, "little") + cs(len(spk)) + spk
    for w in wits:
        o += cs(len(w))
        for it in w: o += cs(len(it)) + it
    return (o + lock.to_bytes(4, "little")).hex()

# ─────────────────────────── PSBT (for walletprocesspsbt) ───────────────────
def build_qbit_psbt(unsigned_hex, htlc_val, htlc_spk, leaf):
    def kv(k, v): return cs(len(k)) + k + cs(len(v)) + v
    out = bytearray(b"psbt\xff")
    out += kv(b"\x00", bytes.fromhex(unsigned_hex)) + b"\x00"           # global unsigned tx
    out += kv(b"\x01", htlc_val.to_bytes(8, "little") + cs(len(htlc_spk)) + htlc_spk)  # witness utxo
    out += kv(b"\x1d\xc1", leaf + b"\xc0") + b"\x00"  # value = script || leaf_version (BIP371-style)                     # PSBT_IN_P2MR_LEAF_SCRIPT
    out += b"\x00"                                                       # output map
    return base64.b64encode(bytes(out)).decode()

# ─────────────────────────── helpers ───────────────────────────────────────
import time, re

def find_vout(node_get, txid, spk_hex):
    raw = node_get("getrawtransaction", txid, True)
    o = next(o for o in raw["vout"] if o["scriptPubKey"]["hex"] == spk_hex)
    return o["n"], int(round(o["value"] * 1e8))

def log(msg): print(msg, flush=True)

def ensure_wallet(cli, name):
    try: cli("createwallet", name)
    except RuntimeError:
        try: cli("loadwallet", name)
        except RuntimeError: pass

def setup():
    """Create/load two wallets per chain and mine spendable coins."""
    for w in ("alice", "bob"):
        ensure_wallet(q, w); ensure_wallet(b, w)
    for w in ("alice", "bob"):  # Qbit blocks signing during the post-load PQC key validation
        for _ in range(60):
            if not q("getwalletinfo", w=w).get("pqc_key_validation", {}).get("signing_blocked", True): break
            time.sleep(2)
    log("[setup] maturing coinbases (mining regtest blocks)...")
    q("generatetoaddress", 1010, q("getnewaddress", w="bob"), w="bob")     # Qbit COINBASE_MATURITY=1000
    b("generatetoaddress", 101, b("getnewaddress", w="alice"), w="alice")
    log(f"[setup] Bob QBT = {q('getbalance', w='bob')} | Alice BTC = {b('getbalance', w='alice')}\n")

def qbit_wallet_pubkey(wallet):  # a fresh SLH-DSA pubkey held by the given Qbit node wallet
    ai = q("getaddressinfo", q("getnewaddress", w=wallet), w=wallet)
    return bytes.fromhex(re.search(r"mr\(pk\(([0-9a-f]{64})", ai["desc"]).group(1))

def qmine(n=1):
    if n > 0: q("generatetoaddress", n, q("getnewaddress", w="bob"), w="bob")
def bmine(n=1):
    if n > 0: b("generatetoaddress", n, b("getnewaddress", w="alice"), w="alice")
def qheight(): return int(q("getblockcount"))
def bheight(): return int(b("getblockcount"))

BTC_KEYS = (0xA11CE, 0xB0B)  # alice_btc_priv, bob_btc_priv (demo constants; parties hold BTC keys directly)

# --- Qbit leg: fund, and spend by having the signer's own node sign the leaf (walletprocesspsbt) ---
def qbit_fund(leaf, amount, from_wallet="bob"):
    txid = q("sendtoaddress", qbit_htlc_addr(leaf), amount, w=from_wallet); qmine()
    n, sats = find_vout(q, txid, qbit_htlc_spk(leaf).hex())
    return txid, n, sats

def qbit_node_spend(txid, n, sats, leaf, signer_pub, signer_wallet, dest_wallet, branch, preimage=None, locktime=0):
    """Sign an HTLC-leaf spend via the signer's Qbit node (walletprocesspsbt = the patched path) and
    finalise the branch witness. branch: 'claim' (reveal preimage) or 'refund' (funder, after CLTV)."""
    dest = q("getnewaddress", w=dest_wallet)
    unsigned = q("createrawtransaction", json.dumps([{"txid": txid, "vout": n}]),
                 json.dumps([{dest: round(sats/1e8 - 0.001, 8)}]), locktime)
    res = q("walletprocesspsbt", build_qbit_psbt(unsigned, sats, qbit_htlc_spk(leaf), leaf), w=signer_wallet)
    sigs = q("decodepsbt", res["psbt"], w=signer_wallet)["inputs"][0].get("p2mr_script_path_sigs")
    if not sigs:
        log("[FAIL] node produced no p2mr script-path signature -- is the node PATCHED?"); sys.exit(1)
    sig = bytes.fromhex(next(e["sig"] for e in sigs if e["pubkey"] == signer_pub.hex()))
    witness = [sig, preimage, b"\x01", leaf, b"\xc1"] if branch == "claim" else [sig, b"", leaf, b"\xc1"]
    return attach_witness(unsigned, [witness])

def q_accept(tx): return q("testmempoolaccept", json.dumps([tx]))[0]["allowed"]
def q_send(tx):
    if not q_accept(tx): return None
    txid = q("sendrawtransaction", tx); qmine(); return txid

# --- Bitcoin leg: fund + spend (ECDSA/BIP143; parties hold the BTC keys directly) ---
def btc_fund(ws, amount, from_wallet="alice"):
    txid = b("sendtoaddress", btc_p2wsh_addr(ws), amount, w=from_wallet); bmine()
    n, sats = find_vout(b, txid, btc_p2wsh_spk(ws).hex())
    return txid, n, sats

def btc_spend(txid, n, sats, ws, priv, dest_wallet, branch, preimage=None, locktime=0):
    dest_spk = bytes.fromhex(b("getaddressinfo", b("getnewaddress", w=dest_wallet), w=dest_wallet)["scriptPubKey"])
    seq = 0xfffffffe if branch == "refund" else 0xffffffff
    vin = [(bytes.fromhex(txid)[::-1], n, seq)]; vout = [(sats - 5000, dest_spk)]
    sig = ecdsa_sign(priv, btc_bip143(2, vin, vout, 0, ws, sats, locktime))
    witness = [sig, preimage, b"\x01", ws] if branch == "claim" else [sig, b"", ws]
    return ser_segwit(2, vin, vout, [witness], locktime)

def b_accept(tx): return b("testmempoolaccept", json.dumps([tx]))[0]["allowed"]
def b_send(tx):
    if not b_accept(tx): return None
    txid = b("sendrawtransaction", tx); bmine(); return txid

def secret_from_qbit_claim(txid, H):
    for x in q("getrawtransaction", txid, True)["vin"][0]["txinwitness"]:
        if len(x) == 64 and sha256(bytes.fromhex(x)) == H: return bytes.fromhex(x)
    return None

def result(ok, detail, msg):
    log(f"\n[result] {detail}")
    log("=== " + ("PASS" if ok else "FAIL") + f" — {msg} ===")
    sys.exit(0 if ok else 1)

# ─────────────────────────── scenarios ─────────────────────────────────────
def scenario_swap():
    """Happy path: both parties execute; the swap completes and nobody can steal."""
    log("=== SCENARIO swap: successful BTC<->QBT atomic swap ===\n"); setup()
    a_btc, b_btc = BTC_KEYS
    a_qbit, b_qbit = qbit_wallet_pubkey("alice"), qbit_wallet_pubkey("bob")
    secret = os.urandom(32); H = sha256(secret)
    lq, lb = qheight() + 20, bheight() + 40                 # lock_qbit < lock_btc
    btc_ws = btc_htlc_ws(H, compressed_pub(b_btc), compressed_pub(a_btc), lb)
    bt, bn, bs = btc_fund(btc_ws, 1);                        log("[alice] funded BTC HTLC (1 BTC)")
    leaf = qbit_htlc_leaf(H, a_qbit, b_qbit, lq)
    qt, qn, qs = qbit_fund(leaf, 5);                         log("[bob]   funded QBT HTLC (5 QBT)\n")
    ctx = q_send(qbit_node_spend(qt, qn, qs, leaf, a_qbit, "alice", "alice", "claim", preimage=secret))
    assert ctx, "qbit claim rejected"
    log("[alice] claimed QBT via walletprocesspsbt  <-- REQUIRES THE PATCH; s is now public")
    s = secret_from_qbit_claim(ctx, H);                     log(f"[bob]   read s from the claim (matches H: {sha256(s)==H})")
    assert b_send(btc_spend(bt, bn, bs, btc_ws, b_btc, "bob", "claim", preimage=s)), "btc claim rejected"
    log("[bob]   claimed BTC")
    aq, bb = float(q("getbalance", w="alice")), float(b("getbalance", w="bob"))
    result(aq >= 4.9 and bb >= 0.9, f"Alice QBT={aq}, Bob BTC={bb}",
           "swap completed; each party got the coin they wanted, atomically")

def scenario_bob_aborts():
    """Alice commits (funds BTC); Bob never funds QBT. Alice must recover her BTC after the timeout."""
    log("=== SCENARIO bob-aborts: Bob never funds after Alice commits -> Alice recovers BTC ===\n"); setup()
    a_btc, b_btc = BTC_KEYS
    H = sha256(os.urandom(32))                              # Bob never reveals anything; H is arbitrary
    lb = bheight() + 6
    btc_ws = btc_htlc_ws(H, compressed_pub(b_btc), compressed_pub(a_btc), lb)
    bt, bn, bs = btc_fund(btc_ws, 1)
    log(f"[alice] funded BTC HTLC (1 BTC); refundable to Alice at height {lb}")
    log("[bob]   ...never funds the QBT side (aborts)")
    refund = btc_spend(bt, bn, bs, btc_ws, a_btc, "alice", "refund", locktime=lb)   # same tx, tried twice
    log(f"[alice] refund BEFORE timeout (h={bheight()} < {lb}): accepted={b_accept(refund)} (expect False)")
    bmine(lb - bheight() + 1)
    rtx = b_send(refund)
    log(f"[alice] refund AFTER timeout  (h={bheight()} >= {lb}): {'broadcast '+rtx[:16]+'..' if rtx else 'REJECTED'}")
    result(rtx is not None, f"Alice BTC balance = {b('getbalance', w='alice')}",
           "Alice reclaimed her BTC; a one-sided abort cost her nothing")

def scenario_alice_aborts():
    """Both fund, but Alice never claims. Bob recovers QBT (via his node), Alice recovers BTC."""
    log("=== SCENARIO alice-aborts: both fund but Alice never claims -> both recover ===\n"); setup()
    a_btc, b_btc = BTC_KEYS
    a_qbit, b_qbit = qbit_wallet_pubkey("alice"), qbit_wallet_pubkey("bob")
    H = sha256(os.urandom(32))                              # Alice never claims, so s is never revealed
    lq, lb = qheight() + 8, bheight() + 6
    btc_ws = btc_htlc_ws(H, compressed_pub(b_btc), compressed_pub(a_btc), lb)
    bt, bn, bs = btc_fund(btc_ws, 1);                       log("[alice] funded BTC HTLC (1 BTC)")
    leaf = qbit_htlc_leaf(H, a_qbit, b_qbit, lq)
    qt, qn, qs = qbit_fund(leaf, 5);                        log(f"[bob]   funded QBT HTLC (5 QBT); refundable to Bob at height {lq}")
    log("[alice] ...never claims the QBT (aborts); the preimage is never revealed\n")
    # Bob reclaims his QBT via his OWN node -- walletprocesspsbt signs the REFUND branch (funder key)
    q_refund = qbit_node_spend(qt, qn, qs, leaf, b_qbit, "bob", "bob", "refund", locktime=lq)
    log(f"[bob]   QBT refund BEFORE timeout (h={qheight()} < {lq}): accepted={q_accept(q_refund)} (expect False)")
    qmine(lq - qheight() + 1)
    qref = q_send(q_refund)
    log(f"[bob]   QBT refund AFTER timeout via walletprocesspsbt: {'ok '+qref[:16]+'..' if qref else 'REJECTED'}  <-- signs the refund branch too")
    # Alice reclaims her BTC
    b_refund = btc_spend(bt, bn, bs, btc_ws, a_btc, "alice", "refund", locktime=lb)
    bmine(lb - bheight() + 1)
    bref = b_send(b_refund)
    log(f"[alice] BTC refund AFTER timeout: {'ok '+bref[:16]+'..' if bref else 'REJECTED'}")
    result(qref is not None and bref is not None,
           f"Bob QBT = {q('getbalance', w='bob')}, Alice BTC = {b('getbalance', w='alice')}",
           "both parties recovered their own funds; the failed swap cost nobody anything")

SCENARIOS = {"swap": scenario_swap, "bob-aborts": scenario_bob_aborts, "alice-aborts": scenario_alice_aborts}

# ─────────────────────────── the swap ───────────────────────────────────────
def main():
    log("=== BTC <-> QBT atomic swap (regtest) ===\n")

    # -- wallets: two parties on each chain (create or load; persist across runs) --
    import time
    def ensure_wallet(cli, name):
        try: cli("createwallet", name)
        except RuntimeError:
            try: cli("loadwallet", name)
            except RuntimeError: pass
    for w in ("alice", "bob"):
        ensure_wallet(q, w); ensure_wallet(b, w)
    # Qbit runs a background PQC key-validation after load that blocks signing until complete.
    for w in ("alice", "bob"):
        for _ in range(60):
            if not q("getwalletinfo", w=w).get("pqc_key_validation", {}).get("signing_blocked", True):
                break
            time.sleep(2)

    # Fund Bob on Qbit (COINBASE_MATURITY=1000) and Alice on Bitcoin.
    log("[setup] maturing coinbases (this mines regtest blocks)...")
    q("generatetoaddress", 1010, q("getnewaddress", w="bob"), w="bob")
    b("generatetoaddress", 101, b("getnewaddress", w="alice"), w="alice")
    log(f"[setup] Bob QBT balance = {q('getbalance', w='bob')}  |  Alice BTC balance = {b('getbalance', w='alice')}\n")

    # -- keys --
    # Bitcoin HTLC keys (held directly by the parties; bitcoind can't sign HTLC branches).
    alice_btc_priv, bob_btc_priv = 0xA11CE, 0xB0B
    alice_btc_pub, bob_btc_pub = compressed_pub(alice_btc_priv), compressed_pub(bob_btc_priv)
    # Qbit HTLC keys: Alice's CLAIM key is a key in her *Qbit node wallet* (so walletprocesspsbt can
    # sign it -- the feature under test). Bob's refund key is likewise from his Qbit wallet.
    import re
    def qbit_wallet_pubkey(wallet):  # a fresh key held by the given Qbit node wallet
        ai = q("getaddressinfo", q("getnewaddress", w=wallet), w=wallet)
        return bytes.fromhex(re.search(r"mr\(pk\(([0-9a-f]{64})", ai["desc"]).group(1))
    alice_qbit_pub = qbit_wallet_pubkey("alice")
    bob_qbit_pub = qbit_wallet_pubkey("bob")

    # -- secret --
    secret = os.urandom(32); H = sha256(secret)
    log(f"[alice] secret s (kept private for now), H = SHA256(s) = {H.hex()}\n")

    # timelocks: Alice (QBT receiver) claims first-expiring; nest with room. Demo values.
    btc_h = int(b("getblockcount")); qbit_h = int(q("getblockcount"))
    lock_qbit = qbit_h + 20    # Bob's refund of QBT available later
    lock_btc = btc_h + 40      # Alice's refund of BTC available even later

    # 1) Alice funds the BTC HTLC (Bob can claim with s).
    btc_ws = btc_htlc_ws(H, bob_btc_pub, alice_btc_pub, lock_btc)
    btc_htlc = btc_p2wsh_addr(btc_ws)
    btc_txid = b("sendtoaddress", btc_htlc, 1, w="alice"); b("generatetoaddress", 1, b("getnewaddress", w="alice"), w="alice")
    bn, bamt = find_vout(b, btc_txid, btc_p2wsh_spk(btc_ws).hex())
    log(f"[alice] funded BTC HTLC {btc_htlc} with 1 BTC")

    # 2) Bob verifies + funds the QBT HTLC (Alice can claim with s).
    qbit_leaf = qbit_htlc_leaf(H, alice_qbit_pub, bob_qbit_pub, lock_qbit)
    qbit_htlc = qbit_htlc_addr(qbit_leaf)
    qbit_txid = q("sendtoaddress", qbit_htlc, 5, w="bob"); q("generatetoaddress", 1, q("getnewaddress", w="bob"), w="bob")
    qn, qamt = find_vout(q, qbit_txid, qbit_htlc_spk(qbit_leaf).hex())
    log(f"[bob]   funded QBT HTLC {qbit_htlc} with 5 QBT\n")

    # 3) Alice claims the QBT HTLC, SIGNING VIA HER OWN QBIT NODE (walletprocesspsbt = the patch).
    alice_dest = q("getnewaddress", w="alice")
    dest_spk = bytes.fromhex(q("getaddressinfo", alice_dest, w="alice")["scriptPubKey"])
    unsigned = q("createrawtransaction",
                 json.dumps([{"txid": qbit_txid, "vout": qn}]),
                 json.dumps([{alice_dest: round(qamt/1e8 - 0.001, 8)}]))
    psbt = build_qbit_psbt(unsigned, qamt, qbit_htlc_spk(qbit_leaf), qbit_leaf)
    processed = q("walletprocesspsbt", psbt, w="alice")
    dec = q("decodepsbt", processed["psbt"], w="alice")
    sigs = dec["inputs"][0].get("p2mr_script_path_sigs")
    if not sigs:
        log("[FAIL] node did not add a p2mr script-path signature -- is the node PATCHED?"); sys.exit(1)
    log("[alice] her Qbit node signed the HTLC leaf via walletprocesspsbt  <-- REQUIRES THE PATCH")
    part_sig = bytes.fromhex(next(e["sig"] for e in sigs if e["pubkey"] == alice_qbit_pub.hex()))
    # finalise the claim witness onto the exact tx the node signed: [sig, preimage, 0x01, leaf, 0xc1]
    claim_tx = attach_witness(unsigned, [[part_sig, secret, b"\x01", qbit_leaf, b"\xc1"]])
    assert q("testmempoolaccept", json.dumps([claim_tx]))[0]["allowed"], "qbit claim rejected"
    qbit_claim_txid = q("sendrawtransaction", claim_tx); q("generatetoaddress", 1, q("getnewaddress", w="bob"), w="bob")
    log(f"[alice] claimed 5 QBT (tx {qbit_claim_txid[:16]}..) -- s is now public on the Qbit chain\n")

    # 4) Bob reads s from Alice's claim witness and claims the BTC HTLC.
    wit = q("getrawtransaction", qbit_claim_txid, True)["vin"][0]["txinwitness"]
    revealed = next(bytes.fromhex(x) for x in wit if len(x) == 64 and sha256(bytes.fromhex(x)) == H)
    log(f"[bob]   extracted s from Alice's claim: {revealed.hex()}  (matches H: {sha256(revealed) == H})")
    bob_dest = b("getnewaddress", w="bob")
    bob_spk = bytes.fromhex(b("getaddressinfo", bob_dest, w="bob")["scriptPubKey"])
    bvin = [(bytes.fromhex(btc_txid)[::-1], bn, 0xffffffff)]
    bvout = [(bamt - 5000, bob_spk)]
    z = btc_bip143(2, bvin, bvout, 0, btc_ws, bamt, 0)
    bsig = ecdsa_sign(bob_btc_priv, z)
    btc_claim = ser_segwit(2, bvin, bvout, [[bsig, revealed, b"\x01", btc_ws]], 0)
    assert b("testmempoolaccept", json.dumps([btc_claim]))[0]["allowed"], "btc claim rejected"
    btc_claim_txid = b("sendrawtransaction", btc_claim); b("generatetoaddress", 1, b("getnewaddress", w="alice"), w="alice")
    log(f"[bob]   claimed ~1 BTC (tx {btc_claim_txid[:16]}..)\n")

    # verify balances moved the right way
    alice_qbt = float(q("getbalance", w="alice")); bob_btc = float(b("getbalance", w="bob"))
    log(f"[result] Alice QBT balance = {alice_qbt}   Bob BTC balance = {bob_btc}")
    ok = alice_qbt >= 4.9 and bob_btc >= 0.9
    log("\n=== SWAP " + ("PASS" if ok else "FAIL") + " — trustless BTC<->QBT swap completed via walletprocesspsbt ===")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "swap"
    if name not in SCENARIOS:
        log(f"usage: atomic_swap_demo.py [{' | '.join(SCENARIOS)}]"); sys.exit(2)
    SCENARIOS[name]()
