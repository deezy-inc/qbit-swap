"""qbit-swap — sidecar for the Qbit leg of a BTC<->QBT atomic swap.

Runs next to the user's own Qbit node. It does the HTLC work the node itself cannot (stock qbitd only
signs pk()/multi_a leaves): derive the p2mr HTLC address, watch/fund it, and sign+finalize the claim
(reveal preimage) and refund (after CLTV) spends. Signing keys are BORROWED from the user's own local
node wallet (xprv via `listdescriptors true` -> re-derived SLH-DSA key), so the user manages no
separate key and nothing sensitive leaves their machine. The remote coordinator stays non-custodial.

Once the node patch (node-patches/) lands, the signing step moves into the node (paste-a-PSBT) and
this sidecar shrinks to the keyless finalizer — the same finalize_* code.
"""
import json, subprocess, shlex, hashlib, os, re
import p2mr, sighash, keyderiv
from txcodec import parse_tx, serialize_tx

PQCTOOL = os.path.join(os.path.dirname(__file__), "pqctool")


class Node:
    """Thin wrapper over the local Qbit node RPC.

    Transport is pluggable: in production this is `qbit-cli`/HTTP-RPC on localhost. For the regtest
    lab it shells to the container over ssh. Only this class knows the transport.
    """
    def __init__(self, base_cmd, hrp="qbrt"):
        self._base = base_cmd            # list[str], e.g. ["qbit-cli","-regtest",...]
        self.hrp = hrp

    @classmethod
    def regtest_lab(cls, host=None, container="qbrt"):
        import os
        host = host or os.environ.get("LAB_SSH_HOST", "localhost")
        inner = f"docker exec {container} qbit-cli -regtest -datadir=/data -rpcuser=lab -rpcpassword=lab"
        return cls(["ssh", "-o", "ConnectTimeout=15", host, "__CLI__"], hrp="qbrt")._with_inner(inner)

    def _with_inner(self, inner): self._inner = inner; return self

    def rpc(self, *args):
        a = ["true" if x is True else "false" if x is False else str(x) for x in args]
        if self._base and self._base[-1] == "__CLI__":
            remote = self._inner + " " + " ".join(shlex.quote(x) for x in a)
            cmd = self._base[:-1] + [remote]
        else:
            cmd = self._base + a
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"rpc {args[0]}: {r.stderr.strip()}")
        s = r.stdout.strip()
        try: return json.loads(s)
        except json.JSONDecodeError: return s

    # convenience
    def height(self): return int(self.rpc("getblockcount"))
    def mine(self, n): self.rpc("generatetoaddress", n, self.rpc("getnewaddress"))  # regtest only
    def spk_of(self, addr): return bytes.fromhex(self.rpc("getaddressinfo", addr)["scriptPubKey"])
    def broadcast(self, hexstr):
        t = self.rpc("testmempoolaccept", json.dumps([hexstr]))[0]
        if not t["allowed"]:
            return {"ok": False, "reason": t.get("reject-reason", t)}
        return {"ok": True, "txid": self.rpc("sendrawtransaction", hexstr)}


class WalletSigner:
    """Borrows signing keys from the local node's own wallet (no separate key management)."""
    def __init__(self, node: Node, range_size=1000):
        self.node = node
        descs = node.rpc("listdescriptors", True)["descriptors"]
        ext = next(d["desc"] for d in descs if "/0/*" in d["desc"] and d["desc"].startswith("mr(pk(pqc("))
        self.xprv = re.search(r"pqc\((qrpv\w+|tqpv\w+|qprv\w+)/", ext).group(1)
        self.ranged = re.sub(r"#\w+$", "", ext)
        ck = node.rpc("getdescriptorinfo", self.ranged)["checksum"]
        self.addr_table = node.rpc("deriveaddresses", f"{self.ranged}#{ck}", json.dumps([0, range_size - 1]))

    def new_key(self):
        """A fresh party key from the wallet: returns (pubkey_hex, index)."""
        addr = self.node.rpc("getnewaddress")
        idx = self.addr_table.index(addr)
        pub, _sk = keyderiv.derive_wallet_key(self.xprv, idx)
        return pub, idx

    def sign(self, index, sighash32: bytes) -> bytes:
        _pub, sk = keyderiv.derive_wallet_key(self.xprv, index)
        r = subprocess.run([PQCTOOL, "sign", sk, sighash32.hex()], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"pqctool sign: {r.stderr.strip()}")
        return bytes.fromhex(r.stdout.strip())


class Htlc:
    """A Qbit-leg HTLC (single p2mr leaf)."""
    def __init__(self, hash_h: bytes, recv_pub: str, fund_pub: str, locktime: int, hrp: str):
        self.h, self.locktime, self.hrp = hash_h, locktime, hrp
        self.recv_pub, self.fund_pub = recv_pub, fund_pub
        self.leaf = p2mr.htlc_leaf_qbit(hash_h, bytes.fromhex(recv_pub), bytes.fromhex(fund_pub), locktime)
        self.spk = p2mr.p2mr_spk(self.leaf)
        self.address = p2mr.p2mr_address(self.leaf, hrp)


class Swap:
    """Orchestrates the Qbit-leg operations a party performs locally."""
    def __init__(self, node: Node):
        self.node = node
        self.signer = WalletSigner(node)

    def required_confirmations(self, value_sats, security_level="high"):
        r = self.node.rpc("getconfirmationtarget", value_sats, security_level)
        return {"confs": r["required_confirmations"], "minutes": r["required_minutes"],
                "equiv_btc": r["equivalent_btc_confirmations"], "level": r["security_level"]}

    def find_funding(self, htlc: Htlc):
        """Non-custodial watch: locate the HTLC UTXO by scriptPubKey (no wallet import)."""
        scan = self.node.rpc("scantxoutset", "start", json.dumps([f"raw({htlc.spk.hex()})"]))
        u = scan.get("unspents", [])
        return u[0] if u else None

    def _spend(self, htlc: Htlc, utxo, signer_index, branch, dest_addr, locktime, sequence):
        txid, vout = utxo["txid"], utxo["vout"]
        in_sats = int(round(utxo["amount"] * 1e8))
        prevout = bytes.fromhex(txid)[::-1]
        dest_spk = self.node.spk_of(dest_addr)
        out_val = in_sats - 100_000  # flat fee for the demo
        sh = sighash.p2mr_sighash(version=2, locktime=locktime, vin=[(prevout, vout, sequence)],
                                  spent_outputs=[(in_sats, htlc.spk)], vout=[(out_val, dest_spk)],
                                  input_index=0, leaf_script=htlc.leaf)
        sig = self.signer.sign(signer_index, sh)
        return self._finalize(prevout, vout, sequence, out_val, dest_spk, locktime, htlc.leaf, branch, sig)

    @staticmethod
    def _finalize(prevout, vout, sequence, out_val, dest_spk, locktime, leaf, branch, sig, preimage=None):
        """Assemble + serialize the branch witness. Keyless — this is the part that survives the node
        patch (the node would produce `sig`, this still finalizes)."""
        if branch == "claim":
            witness = [sig, preimage, b"\x01", leaf, b"\xc1"]
        else:
            witness = [sig, b"", leaf, b"\xc1"]
        t = {"version": 2, "vin": [[prevout, vout, b"", sequence]],
             "vout": [[out_val, dest_spk]], "wit": [witness], "locktime": locktime}
        return serialize_tx(t)

    def claim(self, htlc: Htlc, recv_index, preimage: bytes, dest_addr):
        utxo = self.find_funding(htlc)
        assert utxo, "HTLC not funded yet"
        txid, vout = utxo["txid"], utxo["vout"]
        in_sats = int(round(utxo["amount"] * 1e8))
        prevout = bytes.fromhex(txid)[::-1]
        dest_spk = self.node.spk_of(dest_addr)
        out_val = in_sats - 100_000
        sh = sighash.p2mr_sighash(version=2, locktime=0, vin=[(prevout, vout, 0xffffffff)],
                                  spent_outputs=[(in_sats, htlc.spk)], vout=[(out_val, dest_spk)],
                                  input_index=0, leaf_script=htlc.leaf)
        sig = self.signer.sign(recv_index, sh)
        return self._finalize(prevout, vout, 0xffffffff, out_val, dest_spk, 0, htlc.leaf, "claim", sig, preimage)

    def refund(self, htlc: Htlc, fund_index, dest_addr):
        utxo = self.find_funding(htlc)
        assert utxo, "HTLC not funded yet"
        return self._spend(htlc, utxo, fund_index, "refund", dest_addr,
                           locktime=htlc.locktime, sequence=0xfffffffe)

    @staticmethod
    def secret_from_claim_witness(txinwitness, hash_h):
        for item in txinwitness:
            if len(item) == 64 and hashlib.sha256(bytes.fromhex(item)).digest() == hash_h:
                return item
        return None


# ── self-contained demo: full local round-trip using node-wallet keys ───────
def demo():
    node = Node.regtest_lab()
    swap = Swap(node)
    print(f"[i] node height={node.height()}")
    rc = swap.required_confirmations(500_000_000, "high")
    print(f"[i] reorg-safe target for 5 QBT @ high: {rc['confs']} confs (~{rc['minutes']:.0f} min, "
          f"~{rc['equiv_btc']:.2f} BTC-confs)")

    recv_pub, recv_i = swap.signer.new_key()
    fund_pub, fund_i = swap.signer.new_key()
    preimage = bytes([0x11]) * 32
    H = hashlib.sha256(preimage).digest()

    # ---- CLAIM ----
    print("\n== CLAIM ==")
    htlc = Htlc(H, recv_pub, fund_pub, locktime=200, hrp=node.hrp)
    node.rpc("sendtoaddress", htlc.address, 5); node.mine(1)
    print(f"[i] funded HTLC {htlc.address}")
    dest = node.rpc("getnewaddress")
    tx = swap.claim(htlc, recv_i, preimage, dest)
    r = node.broadcast(tx); node.mine(1)
    print(f"[>] claim: {r}")
    if r["ok"]:
        wit = node.rpc("getrawtransaction", r["txid"], True)["vin"][0]["txinwitness"]
        s = Swap.secret_from_claim_witness(wit, H)
        print(f"[>] secret revealed: {s} (== preimage: {s == preimage.hex()})")

    # ---- REFUND ----
    print("\n== REFUND ==")
    lt = node.height() + 12
    htlc2 = Htlc(H, recv_pub, fund_pub, locktime=lt, hrp=node.hrp)
    node.rpc("sendtoaddress", htlc2.address, 5); node.mine(1)
    dest2 = node.rpc("getnewaddress")
    early = node.broadcast(swap.refund(htlc2, fund_i, dest2))
    print(f"[i] refund before locktime (h={node.height()}<{lt}): allowed={early['ok']} (expect False)")
    node.mine(15)
    late = node.broadcast(swap.refund(htlc2, fund_i, dest2)); node.mine(1)
    print(f"[>] refund after locktime (h={node.height()}>={lt}): {late}")


if __name__ == "__main__":
    demo()
