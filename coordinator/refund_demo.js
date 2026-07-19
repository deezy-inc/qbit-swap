// Recovery scenario: a swap is funded on BOTH legs, then stalls (the taker never claims). Once the
// timelocks pass, each party independently reclaims their own coins — Bob refunds his QBT, Alice
// refunds her BTC — and the coordinator reports REFUNDED. Proves the non-custodial abort guarantee:
// nobody can be left short. Run:  DEV_CONFS_CAP=2 node refund_demo.js
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { startServer } from "./server.js";
import { qbit, btc } from "./chain.js";
import {
  slhDsaKeygen, slhDsaSign, compressedPub, p2mrSighash, serializeTx, P2MR_CONTROL_SINGLE_LEAF, btcSpend,
} from "../client/index.js";

const BASE = "http://127.0.0.1:8788";
const api = async (path, { token, method = "GET", body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { "x-swap-token": token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error}`); return j;
};
const log = (m) => console.log(m);
const until = async (fn, ms = 1200, tries = 80) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, ms)); } throw new Error("timeout"); };
const spkOf = (chain, wallet, addr) => chain.rpcWallet(wallet, "getaddressinfo", addr).then((a) => bin(a.scriptPubKey));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));

async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await new Promise((r) => setTimeout(r, 2000)); }
}
async function makeParty(role) {
  const kp = await slhDsaKeygen(randomBytes(128));
  const btcPriv = randomBytes(32);
  const p = { role, qbit: kp, btcPriv, btcPub: compressedPub(btcPriv) };
  p.qbitDest = await qbit.rpcWallet(role, "getnewaddress");
  p.btcDest = await btc.rpcWallet(role, "getnewaddress");
  if (role === "alice") { p.secret = randomBytes(32); p.H = sha256(p.secret); }
  return p;
}

async function main() {
  await startServer(8788);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 10) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 5) await bmine(101);
  log("=== coordinator recovery (abort -> both parties refund) ===\n");

  const alice = await makeParty("alice"), bob = await makeParty("bob");
  const { id, tokens } = await api("/swaps", { method: "POST", body: { btcSats: 100000000, qbtSats: 500000000, securityLevel: "high" } });
  await api(`/swaps/${id}/party`, { token: tokens.alice, method: "POST", body: { qbitPub: hex(alice.qbit.pk), btcPub: hex(alice.btcPub), btcDest: alice.btcDest, qbitDest: alice.qbitDest, H: hex(alice.H) } });
  const v = await api(`/swaps/${id}/party`, { token: tokens.bob, method: "POST", body: { qbitPub: hex(bob.qbit.pk), btcPub: hex(bob.btcPub), btcDest: bob.btcDest, qbitDest: bob.qbitDest } });
  log(`[coord] swap ${id.slice(0, 12)} -> ${v.state}; locktimes qbit=${v.locktimes.qbit} btc=${v.locktimes.btc}`);

  // Both legs funded, then the swap STALLS — Alice never claims QBT (the abort we recover from).
  await btc.rpcWallet("alice", "sendtoaddress", v.htlc.btc.address, 1); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, 5); await qmineTo(1);
  log("[alice] funded BTC HTLC (1 BTC); [bob] funded QBT HTLC (5 QBT); now both walk away\n");
  await until(async () => { const s = await api(`/swaps/${id}`, { token: tokens.bob }); return s.funding.btc && s.funding.qbit ? s : null; });

  // Advance both chains past the timelocks so refunds become spendable.
  await qmineTo(22); await bmine(42);
  const ready = await until(async () => { const s = await api(`/swaps/${id}`, { token: tokens.bob }); return s.refund?.qbit.available && s.refund?.btc.available ? s : null; });
  log(`[coord] timelocks passed -> refund.available: qbit=${ready.refund.qbit.available} btc=${ready.refund.btc.available}`);

  // Bob refunds his QBT (ELSE branch: empty selector, sig over the fund key, tx locktime = CLTV).
  {
    const f = ready.funding.qbit, leaf = bin(ready.htlc.qbit.leaf), spk = bin(ready.htlc.qbit.spk);
    const destSpk = await spkOf(qbit, "bob", bob.qbitDest), prevoutLE = bin(f.txid).reverse(), outVal = f.amountSats - 100000, lock = ready.locktimes.qbit;
    const sh = p2mrSighash({ version: 2, locktime: lock, vin: [{ txidLE: prevoutLE, vout: f.vout, sequence: 0xfffffffe }], spentOutputs: [{ amount: f.amountSats, spk }], vout: [{ value: outVal, spk: destSpk }], inputIndex: 0, leafScript: leaf });
    const sig = await slhDsaSign(bob.qbit.sk, sh);
    const tx = serializeTx({ version: 2, vin: [[prevoutLE, f.vout, new Uint8Array(0), 0xfffffffe]], vout: [[BigInt(outVal), destSpk]], wit: [[sig, new Uint8Array(0), leaf, P2MR_CONTROL_SINGLE_LEAF]], locktime: lock });
    const r = await api(`/swaps/${id}/broadcast`, { token: tokens.bob, method: "POST", body: { leg: "qbit", kind: "refund", tx: hex(tx) } });
    await qmineTo(1);
    log(`[bob]   refunded QBT ${r.txid.slice(0, 12)} -> ${r.state}`);
  }

  // Alice refunds her BTC (P2WSH refund branch, tx locktime = CLTV).
  {
    const f = ready.funding.btc, ws = bin(ready.htlc.btc.witnessScript);
    const destSpk = await spkOf(btc, "alice", alice.btcDest);
    const tx = btcSpend({ prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: alice.btcPriv, destSpk, outVal: f.amountSats - 5000, branch: "refund", locktime: ready.locktimes.btc });
    const r = await api(`/swaps/${id}/broadcast`, { token: tokens.alice, method: "POST", body: { leg: "btc", kind: "refund", tx: hex(tx) } });
    await bmine(1);
    log(`[alice] refunded BTC ${r.txid.slice(0, 12)} -> ${r.state}`);
  }

  const final = await api(`/swaps/${id}`, { token: tokens.alice });
  const ok = final.state === "REFUNDED" && final.funding.qbit.spent && final.funding.btc.spent && !final.preimage;
  log("\n=== " + (ok ? "PASS" : "FAIL") + ` — both parties recovered; final state ${final.state}, no preimage revealed ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
