"""End-to-end proof: a p2mr HTLC claim whose SLH-DSA signature is produced by the WASM signer,
broadcast to (and accepted by) a regtest qbit node. Run from swaplib/ against your regtest lab."""
import subprocess, json, shlex, hashlib, os
import p2mr, sighash
from txcodec import serialize_tx

HOST = os.environ.get("LAB_SSH_HOST", "localhost")   # regtest lab over ssh; set for a remote host
NODE = "docker exec qbitbuild /src/build/bin/qbit-cli -regtest -datadir=/root/qbrtp -rpcuser=lab -rpcpassword=lab"
WASMSIGN = os.path.join(os.path.dirname(__file__), "wasm", "wasmsign.js")

# controlled vanity keypairs (seed 0x11 / 0x22); we hold the SLH-DSA secret keys
RECV_PUB = "d6c2b3977708d7de974059b650874bc1555ff3194962627737f97dbaefe3dd39"
RECV_SK  = "21d53e8c37f8b27e965881c331e20f75019cacd578a91f593309ecdb2c6b9a3bd6c2b3977708d7de974059b650874bc1555ff3194962627737f97dbaefe3dd39"
FUND_PUB = "7d6b1ab4e067e6b1aff97ea1c4fcf58cd01d841130a1c78d5a0c242f58f08bf1"
PREIMAGE = bytes([0x11]) * 32
H = hashlib.sha256(PREIMAGE).digest()

def cli(*args):
    a = ["true" if x is True else "false" if x is False else str(x) for x in args]
    remote = NODE + " " + " ".join(shlex.quote(x) for x in a)
    r = subprocess.run(["ssh", "-o", "ConnectTimeout=15", HOST, remote], capture_output=True, text=True)
    if r.returncode: raise RuntimeError(f"cli {args[0]}: {r.stderr.strip()}")
    s = r.stdout.strip()
    try: return json.loads(s)
    except json.JSONDecodeError: return s

def wasm_sign(sk_hex, digest32: bytes) -> bytes:
    out = subprocess.run(["node", WASMSIGN, sk_hex, digest32.hex()], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(f"wasm sign: {out.stderr.strip()}")
    return bytes.fromhex(out.stdout.strip())

def main():
    try: cli("loadwallet", "bob")
    except RuntimeError: pass
    import time
    for _ in range(40):
        wi = json.loads(subprocess.run(["ssh", HOST, NODE + " -rpcwallet=bob getwalletinfo"], capture_output=True, text=True).stdout)
        if not wi.get("pqc_key_validation", {}).get("signing_blocked", True): break
        time.sleep(2)

    def wcli(*args):  # bob-scoped
        a = ["true" if x is True else "false" if x is False else str(x) for x in args]
        remote = NODE + " -rpcwallet=bob " + " ".join(shlex.quote(x) for x in a)
        r = subprocess.run(["ssh", HOST, remote], capture_output=True, text=True)
        if r.returncode: raise RuntimeError(f"{args[0]}: {r.stderr.strip()}")
        try: return json.loads(r.stdout.strip())
        except json.JSONDecodeError: return r.stdout.strip()

    leaf = p2mr.htlc_leaf_qbit(H, bytes.fromhex(RECV_PUB), bytes.fromhex(FUND_PUB), 200)
    spk = p2mr.p2mr_spk(leaf); addr = p2mr.p2mr_address(leaf, "qbrt")
    print(f"[i] HTLC {addr}")
    txid = wcli("sendtoaddress", addr, 5); wcli("generatetoaddress", 1, wcli("getnewaddress"))
    raw = wcli("getrawtransaction", txid, True)
    o = next(o for o in raw["vout"] if o["scriptPubKey"]["hex"] == spk.hex())
    n, sats = o["n"], int(round(o["value"] * 1e8))
    print(f"[i] funded {txid[:16]}..:{n} = {sats/1e8} QBT")

    dest = wcli("getnewaddress"); dest_spk = bytes.fromhex(wcli("getaddressinfo", dest)["scriptPubKey"])
    prevout = bytes.fromhex(txid)[::-1]; out_val = sats - 100_000
    sh = sighash.p2mr_sighash(version=2, locktime=0, vin=[(prevout, n, 0xffffffff)],
                              spent_outputs=[(sats, spk)], vout=[(out_val, dest_spk)],
                              input_index=0, leaf_script=leaf)
    print(f"[i] P2MR sighash = {sh.hex()}")
    sig = wasm_sign(RECV_SK, sh)
    print(f"[i] SLH-DSA signature from WASM signer: {len(sig)} bytes")
    tx = serialize_tx({"version": 2, "vin": [[prevout, n, b"", 0xffffffff]],
                       "vout": [[out_val, dest_spk]], "wit": [[sig, PREIMAGE, b"\x01", leaf, b"\xc1"]], "locktime": 0})
    acc = wcli("testmempoolaccept", json.dumps([tx]))[0]
    print(f"[>] node testmempoolaccept: allowed={acc['allowed']} {acc.get('reject-reason','')}")
    if acc["allowed"]:
        ctxid = wcli("sendrawtransaction", tx); wcli("generatetoaddress", 1, wcli("getnewaddress"))
        wit = wcli("getrawtransaction", ctxid, True)["vin"][0]["txinwitness"]
        revealed = next(x for x in wit if len(x) == 64 and hashlib.sha256(bytes.fromhex(x)).digest() == H)
        print(f"[>] WASM-signed claim ACCEPTED by node: {ctxid}")
        print(f"[>] preimage revealed on-chain: {revealed} (== ours: {revealed == PREIMAGE.hex()})")
        print("\n=== PASS — a WASM-signed p2mr HTLC claim was accepted by the Qbit node ===")
    else:
        print("=== FAIL ===")

if __name__ == "__main__":
    main()
