// Two headless bots drive a full BTC<->QBT swap through the coordinator's HTTP API, signing entirely
// client-side with the swaplib/js library. Proves the coordinator + the bot-facing API end to end.
// Run:  DEV_CONFS_CAP=2 node demo.js
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { startServer } from "./server.js";
import { qbit, btc } from "./chain.js";
import {
  slhDsaKeygen, slhDsaSign, compressedPub, htlcLeafQbit, p2mrSpk, p2mrSighash, serializeTx,
  P2MR_CONTROL_SINGLE_LEAF, btcSpend,
} from "../js/index.js";

const BASE = "http://127.0.0.1:8787";
const api = async (path, { token, method = "GET", body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { "x-swap-token": token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error}`); return j;
};
const log = (m) => console.log(m);
const until = async (fn, ms = 1500, tries = 60) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, ms)); } throw new Error("timeout"); };

async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await new Promise((r) => setTimeout(r, 2000)); }
}
const qmine = (n) => qbit.rpcWallet("bob", "generatetoaddress", n, "" + "").catch(() => qbit.mine(n, ""));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const spkOf = (chain, wallet, addr) => chain.rpcWallet(wallet, "getaddressinfo", addr).then((a) => bin(a.scriptPubKey));

async function makeParty(role) {
  const kp = await slhDsaKeygen(randomBytes(128));                       // QBT SLH-DSA keypair
  const btcPriv = randomBytes(32);
  const p = { role, qbit: kp, btcPriv, btcPub: compressedPub(btcPriv) };
  p.qbitDest = await qbit.rpcWallet(role, "getnewaddress");              // where this party receives QBT
  p.btcDest = await btc.rpcWallet(role, "getnewaddress");                //   ... and BTC
  if (role === "alice") { p.secret = randomBytes(32); p.H = sha256(p.secret); }
  return p;
}

async function main() {
  await startServer(8787);
  await loadWallets();
  // wallets are pre-funded from earlier runs; ensure a little maturity headroom
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 10) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 5) await bmine(101);
  log("=== coordinator + two-bot BTC<->QBT swap ===\n");

  const alice = await makeParty("alice"), bob = await makeParty("bob");
  // Alice creates the swap (terms agreed off-band) and shares Bob's token as his link.
  const { id, tokens } = await api("/swaps", { method: "POST", body: { btcSats: 100000000, qbtSats: 500000000, securityLevel: "high" } });
  log(`[coord] swap ${id.slice(0, 12)} created`);

  await api(`/swaps/${id}/party`, { token: tokens.alice, method: "POST", body: { qbitPub: hex(alice.qbit.pk), btcPub: hex(alice.btcPub), btcDest: alice.btcDest, qbitDest: alice.qbitDest, H: hex(alice.H) } });
  const v = await api(`/swaps/${id}/party`, { token: tokens.bob, method: "POST", body: { qbitPub: hex(bob.qbit.pk), btcPub: hex(bob.btcPub), btcDest: bob.btcDest, qbitDest: bob.qbitDest } });
  log(`[coord] both joined -> ${v.state}; reorg-safe target = ${v.confsTarget.confs} confs`);
  log(`[coord] BTC HTLC ${v.htlc.btc.address}\n[coord] QBT HTLC ${v.htlc.qbit.address}\n`);

  // Fund (parties send from their own wallets; here the node wallets stand in).
  await btc.rpcWallet("alice", "sendtoaddress", v.htlc.btc.address, 1); await bmine(1);
  log("[alice] funded BTC HTLC (1 BTC)");
  await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, 5); await qmineTo(1);
  log("[bob]   funded QBT HTLC (5 QBT)");
  // accrue reorg-safe confs
  await qmineTo(2);
  const claimable = await until(async () => { const s = await api(`/swaps/${id}`, { token: tokens.alice }); return s.state === "CLAIMABLE" ? s : null; });
  log(`[coord] QBT funding matured -> ${claimable.state} (${claimable.funding.qbit.confs} confs)\n`);

  // Alice claims QBT client-side (WASM SLH-DSA), submits to the coordinator to broadcast.
  {
    const f = claimable.funding.qbit, leaf = bin(claimable.htlc.qbit.leaf), spk = bin(claimable.htlc.qbit.spk);
    const destSpk = await spkOf(qbit, "alice", alice.qbitDest), prevoutLE = bin(f.txid).reverse(), outVal = f.amountSats - 100000;
    const sh = p2mrSighash({ version: 2, locktime: 0, vin: [{ txidLE: prevoutLE, vout: f.vout, sequence: 0xffffffff }], spentOutputs: [{ amount: f.amountSats, spk }], vout: [{ value: outVal, spk: destSpk }], inputIndex: 0, leafScript: leaf });
    const sig = await slhDsaSign(alice.qbit.sk, sh);
    const tx = serializeTx({ version: 2, vin: [[prevoutLE, f.vout, new Uint8Array(0), 0xffffffff]], vout: [[BigInt(outVal), destSpk]], wit: [[sig, alice.secret, Uint8Array.of(0x01), leaf, P2MR_CONTROL_SINGLE_LEAF]], locktime: 0 });
    const r = await api(`/swaps/${id}/broadcast`, { token: tokens.alice, method: "POST", body: { leg: "qbit", kind: "claim", tx: hex(tx) } });
    await qmineTo(1);
    log(`[alice] claimed QBT via her node signer -> coordinator broadcast ${r.txid.slice(0, 12)}; state ${r.state}`);
  }

  // Bob reads the now-public preimage from the coordinator and claims BTC.
  const claimed = await until(async () => { const s = await api(`/swaps/${id}`, { token: tokens.bob }); return s.preimage ? s : null; });
  log(`[bob]   read preimage from coordinator: ${claimed.preimage.slice(0, 16)}..`);
  {
    const f = claimed.funding.btc, ws = bin(claimed.htlc.btc.witnessScript);
    const destSpk = await spkOf(btc, "bob", bob.btcDest);
    const tx = btcSpend({ prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: bob.btcPriv, destSpk, outVal: f.amountSats - 5000, branch: "claim", preimage: bin(claimed.preimage) });
    const r = await api(`/swaps/${id}/broadcast`, { token: tokens.bob, method: "POST", body: { leg: "btc", kind: "claim", tx: hex(tx) } });
    await bmine(1);
    log(`[bob]   claimed BTC -> coordinator broadcast ${r.txid.slice(0, 12)}; state ${r.state}`);
  }

  const final = await api(`/swaps/${id}`, { token: tokens.alice });
  const ok = final.state === "COMPLETE";
  log("\n=== " + (ok ? "PASS" : "FAIL") + ` — coordinator drove a full swap to ${final.state} via its API ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
