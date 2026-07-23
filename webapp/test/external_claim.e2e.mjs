// Regression e2e for the missing-claim-txid bug: when a claim is broadcast OUT OF BAND (a party's own
// node, or the client's direct-broadcast fallback) the coordinator sees the deposit spent but never ran
// applyEffects, so the swap could reach COMPLETE with an EMPTY broadcasts map (no claim txid recorded).
// Here both claims are broadcast straight to the chain, bypassing POST /swaps/:id/broadcast — and we
// assert the coordinator's poll() backfills both claim txids (and the revealed preimage) anyway.
//   Run:  node test/external_claim.e2e.mjs
import { randomBytes } from "node:crypto";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { slhDsaKeygen, slhDsaSign, compressedPub, p2mrSighash, serializeTx, P2MR_CONTROL_SINGLE_LEAF, btcSpend, splitterAddress } from "@qbit-swap/client";
import { installMocks } from "./mockchain.mjs";

process.env.COORD_CHAIN = "dev";
process.env.BTC_BLOCK_SECS = "1"; process.env.QBIT_BLOCK_SECS = "1";
process.env.HTLC_TO_SECS = "60"; process.env.HTLC_FROM_SECS = "120";
process.env.DEV_CONFS_CAP = "2"; process.env.FUNDING_WINDOW_MS = "600000"; process.env.RATE_MAX = "100000";
const { startServer } = await import("../../coordinator/server.js");
const { qbit, btc } = await import("../../coordinator/chain.js");
const mock = installMocks(qbit, btc);

const PORT = 8806, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(o.token ? { "x-swap-token": o.token } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j; };
const until = async (fn, ms = 250, tries = 300) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(ms); } throw new Error("until: timeout"); };
let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const dest = () => splitterAddress(randomBytes(32), "bcrt").address;

async function party() {
  const kp = await slhDsaKeygen(randomBytes(128)), btcPriv = randomBytes(32);
  return { kp, btcPriv, btcPub: compressedPub(btcPriv), qbitDestSpk: randomBytes(22), btcDestSpk: randomBytes(22) };
}

async function main() {
  await startServer(PORT);
  const alice = await party(), bob = await party();
  const secret = randomBytes(32), H = sha256(secret);

  const { id, tokens } = await api("/swaps", { method: "POST", body: { btcSats: 20_000_000, qbtSats: 100_000_000, securityLevel: "high" } });
  await api(`/swaps/${id}/party`, { token: tokens.alice, method: "POST", body: { qbitPub: hex(alice.kp.pk), btcPub: hex(alice.btcPub), btcDest: dest(), qbitDest: dest(), H: hex(H) } });
  await api(`/swaps/${id}/party`, { token: tokens.bob, method: "POST", body: { qbitPub: hex(bob.kp.pk), btcPub: hex(bob.btcPub), btcDest: dest(), qbitDest: dest() } });
  const ready = await until(async () => { const v = await api(`/swaps/${id}`, { token: tokens.alice }); return v.htlc ? v : null; });

  // Fund both legs on-chain, mature to CLAIMABLE — all normal.
  mock.btc.fundSpk(ready.htlc.btc.spk, ready.terms.btcSats); mock.btc.mine(2);
  await until(async () => (await api(`/swaps/${id}`, { token: tokens.bob })).fundGate?.cleared);
  mock.qbit.fundSpk(ready.htlc.qbit.spk, ready.terms.qbtSats); mock.qbit.mine(2);
  const claimable = await until(async () => { const v = await api(`/swaps/${id}`, { token: tokens.alice }); return v.state === "CLAIMABLE" ? v : null; });
  ck(claimable.state === "CLAIMABLE" && !claimable.broadcasts["qbit:claim"], "swap CLAIMABLE, no claim recorded yet");

  // ── Alice claims QBT OUT OF BAND (straight to the chain, NOT via the coordinator) ────────────────
  const qf = claimable.funding.qbit, leaf = bin(claimable.htlc.qbit.leaf), qspk = bin(claimable.htlc.qbit.spk);
  const qPrevLE = bin(qf.txid).reverse(), qOut = qf.amountSats - 100000;
  const qsh = p2mrSighash({ version: 2, locktime: 0, vin: [{ txidLE: qPrevLE, vout: qf.vout, sequence: 0xffffffff }], spentOutputs: [{ amount: qf.amountSats, spk: qspk }], vout: [{ value: qOut, spk: alice.qbitDestSpk }], inputIndex: 0, leafScript: leaf });
  const qsig = await slhDsaSign(alice.kp.sk, qsh);
  const qtx = serializeTx({ version: 2, vin: [[qPrevLE, qf.vout, new Uint8Array(0), 0xffffffff]], vout: [[BigInt(qOut), alice.qbitDestSpk]], wit: [[qsig, secret, Uint8Array.of(0x01), leaf, P2MR_CONTROL_SINGLE_LEAF]], locktime: 0 });
  const qClaimTxid = await mock.qbit.broadcast(hex(qtx)); mock.qbit.mine(1);   // ← bypasses the coordinator entirely

  // The coordinator's poll must now backfill the QBT claim txid AND extract the revealed preimage.
  const afterQbt = await until(async () => { const v = await api(`/swaps/${id}`, { token: tokens.bob }); return v.broadcasts["qbit:claim"] ? v : null; });
  ck(afterQbt.broadcasts["qbit:claim"] === qClaimTxid, "coordinator backfilled the QBT claim txid from the out-of-band spend");
  ck(afterQbt.preimage === hex(secret), "coordinator recovered the preimage from the out-of-band claim's witness");

  // ── Bob claims BTC OUT OF BAND using the now-public preimage ─────────────────────────────────────
  const bf = afterQbt.funding.btc, ws = bin(afterQbt.htlc.btc.witnessScript);
  const btx = btcSpend({ prevTxidLE: bin(bf.txid).reverse(), vout: bf.vout, amount: bf.amountSats, ws, priv: bob.btcPriv, destSpk: bob.btcDestSpk, outVal: bf.amountSats - 5000, branch: "claim", preimage: bin(afterQbt.preimage) });
  const bClaimTxid = await mock.btc.broadcast(hex(btx)); mock.btc.mine(1);

  const final = await until(async () => { const v = await api(`/swaps/${id}`, { token: tokens.alice }); return v.state === "COMPLETE" ? v : null; });
  ck(final.state === "COMPLETE", "swap reached COMPLETE from the out-of-band claims");
  ck(final.broadcasts["btc:claim"] === bClaimTxid, "coordinator backfilled the BTC claim txid too (the bug: this was missing)");
  ck(!!final.broadcasts["qbit:claim"] && !!final.broadcasts["btc:claim"], "a COMPLETE swap now records BOTH claim txids");

  console.log(ok ? "\nPASS — out-of-band claim txids are backfilled; no COMPLETE swap is left without its claim tx" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
