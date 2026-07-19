"""Validate the Bitcoin P2WSH HTLC leg against a regtest bitcoind: fund -> claim -> refund."""
import subprocess, json, shlex, hashlib
import bitcoin_htlc as btc

import os
HOST = os.environ.get("LAB_SSH_HOST", "localhost")
BCLI = "docker exec btcregtest bitcoin-cli -regtest -rpcuser=lab -rpcpassword=lab"

def cli(*a):
    a = ["true" if x is True else "false" if x is False else str(x) for x in a]
    r = subprocess.run(["ssh", "-o", "ConnectTimeout=15", HOST, BCLI + " " + " ".join(shlex.quote(x) for x in a)],
                       capture_output=True, text=True)
    if r.returncode: raise RuntimeError(f"{a[0]}: {r.stderr.strip()}")
    s = r.stdout.strip()
    try: return json.loads(s)
    except json.JSONDecodeError: return s

def wcli(w, *a):  # wallet-scoped
    a = ["true" if x is True else "false" if x is False else str(x) for x in a]
    r = subprocess.run(["ssh", "-o", "ConnectTimeout=15", HOST,
                        f"{BCLI} -rpcwallet={w} " + " ".join(shlex.quote(x) for x in a)],
                       capture_output=True, text=True)
    if r.returncode: raise RuntimeError(f"{a[0]}: {r.stderr.strip()}")
    s = r.stdout.strip()
    try: return json.loads(s)
    except json.JSONDecodeError: return s

def spk_of(addr): return bytes.fromhex(cli("getaddressinfo", addr)["scriptPubKey"])
def fund_and_confirm(w, addr, btc_amt):
    txid = wcli(w, "sendtoaddress", addr, btc_amt)
    wcli(w, "generatetoaddress", 1, wcli(w, "getnewaddress"))
    raw = cli("getrawtransaction", txid, True)
    return txid, next(o for o in raw["vout"] if o["scriptPubKey"]["hex"] == "unused")  # replaced below

def main():
    try: cli("createwallet", "btc")
    except RuntimeError: pass
    W = "btc"
    miner = wcli(W, "getnewaddress")
    wcli(W, "generatetoaddress", 101, miner)
    print(f"[i] btc wallet balance: {wcli(W, 'getbalance')}")

    claim_priv, refund_priv = 0xB0B, 0xA11CE
    claim_pub, refund_pub = btc.pubkey(claim_priv), btc.pubkey(refund_priv)
    preimage = bytes([0x11]) * 32
    H = hashlib.sha256(preimage).digest()

    # ---- CLAIM ----
    print("\n== BTC CLAIM ==")
    ws = btc.htlc_witness_script(H, claim_pub, refund_pub, 200)
    addr = btc.p2wsh_address(ws)
    txid = wcli(W, "sendtoaddress", addr, 1); wcli(W, "generatetoaddress", 1, miner)
    raw = cli("getrawtransaction", txid, True)
    vo = next(o for o in raw["vout"] if o["scriptPubKey"]["hex"] == btc.p2wsh_spk(ws).hex())
    amt = int(round(vo["value"] * 1e8)); n = vo["n"]
    print(f"[i] funded P2WSH {addr} = {vo['value']} BTC")
    dest = spk_of(wcli(W, "getnewaddress"))
    tx = btc.spend(txid, n, amt, ws, dest, amt - 5000, branch="claim", priv=claim_priv, preimage=preimage)
    test = cli("testmempoolaccept", json.dumps([tx]))[0]
    print(f"[>] claim accepted={test['allowed']} {test.get('reject-reason','')}")
    if test["allowed"]: print(f"[>] claim txid: {cli('sendrawtransaction', tx)}")

    # ---- REFUND ----
    print("\n== BTC REFUND ==")
    h = wcli(W, "getblockcount"); lt = h + 5
    ws2 = btc.htlc_witness_script(H, claim_pub, refund_pub, lt)
    addr2 = btc.p2wsh_address(ws2)
    txid2 = wcli(W, "sendtoaddress", addr2, 1); wcli(W, "generatetoaddress", 1, miner)
    raw2 = cli("getrawtransaction", txid2, True)
    vo2 = next(o for o in raw2["vout"] if o["scriptPubKey"]["hex"] == btc.p2wsh_spk(ws2).hex())
    amt2 = int(round(vo2["value"] * 1e8)); n2 = vo2["n"]
    dest2 = spk_of(wcli(W, "getnewaddress"))
    early = btc.spend(txid2, n2, amt2, ws2, dest2, amt2 - 5000, branch="refund", priv=refund_priv, locktime=lt, sequence=0xfffffffe)
    print(f"[i] refund before locktime (h={wcli(W,'getblockcount')}<{lt}): allowed={cli('testmempoolaccept', json.dumps([early]))[0]['allowed']} (expect False)")
    wcli(W, "generatetoaddress", 6, miner)
    late = btc.spend(txid2, n2, amt2, ws2, dest2, amt2 - 5000, branch="refund", priv=refund_priv, locktime=lt, sequence=0xfffffffe)
    t = cli("testmempoolaccept", json.dumps([late]))[0]
    print(f"[>] refund after locktime (h={wcli(W,'getblockcount')}>={lt}): allowed={t['allowed']} {t.get('reject-reason','')}")
    if t["allowed"]: print(f"[>] refund txid: {cli('sendrawtransaction', late)}")

if __name__ == "__main__":
    main()
