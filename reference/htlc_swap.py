"""Full signed HTLC round-trip on the Qbit p2mr leg (regtest), end to end.

Runs LOCALLY: builds/derives everything here, produces SLH-DSA signatures with the local `pqcsign`
(libbitcoinpqc), and talks to the isolated `qbrt` regtest node over ssh. Proves:
  fund -> claim-with-preimage (reveals s) ; and refund-after-CLTV (rejected early, accepted late).

Keys are fully controlled (derived from known vanity seeds), so we can sign both branches ourselves
without the node (whose signer only handles pk()/multi_a leaves, not HTLC leaves)."""
import subprocess, hashlib, json, shlex, os
import p2mr, sighash
from txcodec import parse_tx, serialize_tx

import os
HOST = os.environ.get("LAB_SSH_HOST", "localhost")
CLI = "docker exec qbrt qbit-cli -regtest -datadir=/data -rpcuser=lab -rpcpassword=lab"
PQCSIGN = os.path.join(os.path.dirname(__file__), "pqcsign")

# fully-controlled keypairs (vanity --seed 11..11 / 22..22 --hrp qbrt)
RECV_PUB = "d6c2b3977708d7de974059b650874bc1555ff3194962627737f97dbaefe3dd39"
RECV_SK  = "21d53e8c37f8b27e965881c331e20f75019cacd578a91f593309ecdb2c6b9a3bd6c2b3977708d7de974059b650874bc1555ff3194962627737f97dbaefe3dd39"
FUND_PUB = "7d6b1ab4e067e6b1aff97ea1c4fcf58cd01d841130a1c78d5a0c242f58f08bf1"
FUND_SK  = "a85120ed1bac2bbfccfb9d84382ed5ad83afc0d5b4b1c0f9ad9dc416422435cc7d6b1ab4e067e6b1aff97ea1c4fcf58cd01d841130a1c78d5a0c242f58f08bf1"

PREIMAGE = bytes([0x11]) * 32
H = hashlib.sha256(PREIMAGE).digest()

def _arg(a):
    if a is True: return "true"
    if a is False: return "false"
    return str(a)

def cli(*args):
    remote = CLI + " " + " ".join(shlex.quote(_arg(a)) for a in args)
    r = subprocess.run(["ssh", "-o", "ConnectTimeout=15", HOST, remote],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"cli {args[0]}: {r.stderr.strip()}")
    s = r.stdout.strip()
    try: return json.loads(s)
    except json.JSONDecodeError: return s

def pqc_sign(sk_hex, sighash_bytes):
    r = subprocess.run([PQCSIGN, sk_hex, sighash_bytes.hex()], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"pqcsign: {r.stderr.strip()}")
    return bytes.fromhex(r.stdout.strip())

def height(): return int(cli("getblockcount"))
def mine(n): cli("generatetoaddress", n, cli("getnewaddress"))

def addr_spk(addr):
    return bytes.fromhex(cli("getaddressinfo", addr)["scriptPubKey"])

def fund(htlc_addr, htlc_spk, amount_qbt=5):
    txid = cli("sendtoaddress", htlc_addr, amount_qbt)
    mine(1)
    raw = cli("getrawtransaction", txid, True)
    for o in raw["vout"]:
        if o["scriptPubKey"]["hex"] == htlc_spk.hex():
            return txid, o["n"], int(round(o["value"] * 1e8))
    raise RuntimeError("funded vout not found")

def build_spend(txid, vout, in_amount_sats, leaf, sk_hex, branch, dest_spk, locktime, sequence):
    prevout = bytes.fromhex(txid)[::-1]            # display -> internal LE
    htlc_spk = p2mr.p2mr_spk(leaf)
    fee = 100_000
    out_val = in_amount_sats - fee
    # sighash commits to the tx; witness is added after and doesn't change it
    sh = sighash.p2mr_sighash(
        version=2, locktime=locktime,
        vin=[(prevout, vout, sequence)],
        spent_outputs=[(in_amount_sats, htlc_spk)],
        vout=[(out_val, dest_spk)],
        input_index=0, leaf_script=leaf)
    sig = pqc_sign(sk_hex, sh)
    if branch == "claim":
        witness = [sig, PREIMAGE, b"\x01", leaf, b"\xc1"]
    else:
        witness = [sig, b"", leaf, b"\xc1"]
    t = {"version": 2, "vin": [[prevout, vout, b"", sequence]],
         "vout": [[out_val, dest_spk]], "wit": [witness], "locktime": locktime}
    return serialize_tx(t)

def broadcast(hexstr):
    test = cli("testmempoolaccept", json.dumps([hexstr]))
    if not test[0]["allowed"]:
        return {"ok": False, "reason": test[0].get("reject-reason", test[0])}
    txid = cli("sendrawtransaction", hexstr)
    mine(1)
    return {"ok": True, "txid": txid}

def secret_from_claim(txid):
    wit = cli("getrawtransaction", txid, True)["vin"][0]["txinwitness"]
    for item in wit:
        if len(item) == 64 and hashlib.sha256(bytes.fromhex(item)).digest() == H:
            return item
    return None

def main():
    print(f"[i] height={height()}  H={H.hex()}")

    # ================= CLAIM =================
    print("\n== CLAIM (receiver reveals preimage) ==")
    leaf = p2mr.htlc_leaf_qbit(H, bytes.fromhex(RECV_PUB), bytes.fromhex(FUND_PUB), 200)
    spk = p2mr.p2mr_spk(leaf); addr = p2mr.p2mr_address(leaf, "qbrt")
    print(f"[i] HTLC {addr}")
    txid, vout, amt = fund(addr, spk)
    print(f"[i] funded {txid}:{vout} = {amt/1e8} QBT")
    dest = cli("getnewaddress")
    claim = build_spend(txid, vout, amt, leaf, RECV_SK, "claim", addr_spk(dest),
                        locktime=0, sequence=0xffffffff)
    r = broadcast(claim)
    print(f"[>] claim broadcast: {r}")
    if r["ok"]:
        s = secret_from_claim(r["txid"])
        print(f"[>] secret revealed on-chain: {s}  (== preimage: {s == PREIMAGE.hex()})")

    # ================= REFUND =================
    print("\n== REFUND (funder reclaims after CLTV timeout) ==")
    lt = height() + 12
    leaf2 = p2mr.htlc_leaf_qbit(H, bytes.fromhex(RECV_PUB), bytes.fromhex(FUND_PUB), lt)
    spk2 = p2mr.p2mr_spk(leaf2); addr2 = p2mr.p2mr_address(leaf2, "qbrt")
    print(f"[i] HTLC {addr2} locktime={lt}")
    txid2, vout2, amt2 = fund(addr2, spk2)
    dest2 = cli("getnewaddress")
    # early refund must be rejected by CLTV
    early = build_spend(txid2, vout2, amt2, leaf2, FUND_SK, "refund", addr_spk(dest2),
                        locktime=lt, sequence=0xfffffffe)
    er = broadcast(early)
    print(f"[i] refund at height={height()} (< {lt}): allowed={er['ok']}  (expect False; reason={er.get('reason')})")
    mine(15)
    late = build_spend(txid2, vout2, amt2, leaf2, FUND_SK, "refund", addr_spk(dest2),
                       locktime=lt, sequence=0xfffffffe)
    lr = broadcast(late)
    print(f"[>] refund at height={height()} (>= {lt}): {lr}")

if __name__ == "__main__":
    main()
