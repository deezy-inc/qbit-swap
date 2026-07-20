// Watchtower fee-tier selection, end to end: both parties arm and go offline, and the mempool is
// (mocked) expensive — so when the coordinator broadcasts the offline participant's pre-signed BTC
// claim, it must pick the fastest-fee-appropriate LADDER TIER, not the cheapest one. Proves the
// watchtower actually sizes its broadcast to live fees (the ladder's whole purpose).
//   Run:  (source deploy/lab.env) DEV_CONFS_CAP=2 node test/wtescalate.e2e.mjs
const FEES = { fastestFee: 30, halfHourFee: 20, hourFee: 12, economyFee: 4, minimumFee: 1 };
const realFetch = globalThis.fetch;                         // pass client↔coordinator API calls through;
globalThis.fetch = async (u, o) => String(u).includes("fees/recommended")   // only fake the fee oracle.
  ? { ok: true, json: async () => FEES } : realFetch(u, o);

import { startServer } from "../../coordinator/server.js";
import { getSwap, pickTier } from "../../coordinator/swap.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8803, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await sleep(2000); }
}
let ok = true;
const chk = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) ok = false; };

async function main() {
  await startServer(PORT);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 20) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);

  const dests = async (w) => ({ btcDest: await btc.rpcWallet(w, "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet(w, "getnewaddress") });
  const alice = new SwapClient({ coordinator: BASE }), bob = new SwapClient({ coordinator: BASE });
  const { id, inviteToken } = await alice.create({ role: "alice", btcSats: 100000000, qbtSats: 500000000, securityLevel: "high", ...(await dests("alice")) });
  await bob.join({ id, token: inviteToken, ...(await dests("bob")) });
  alice.start(); bob.start();

  let v; for (let i = 0; i < 60 && !(v = alice.view)?.htlc; i++) await sleep(500);
  await btc.rpcWallet("alice", "sendtoaddress", v.htlc.btc.address, 1); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, 5); await qmineTo(1);
  // both clients pre-sign their fee-ladder bundles, then CLOSE THEIR TABS
  await (async () => { for (let i = 0; i < 60; i++) { const s = getSwap(id); if (s?.finish?.alice && s?.finish?.bob) return; await sleep(1000); } throw new Error("never armed"); })();
  alice.stop(); bob.stop();
  console.log("  both armed + offline; mempool fastestFee mocked at", FEES.fastestFee, "sat/vB");

  // Mature both legs so the coordinator (alone) drives it to COMPLETE via the pre-signed ladder.
  let s, done = false; const end = Date.now() + 120000;
  while (Date.now() < end) { await bmine(1); await qmineTo(1); s = getSwap(id); if (s.state === "COMPLETE") { done = true; break; } await sleep(2000); }
  chk(done, `coordinator drove the swap to COMPLETE with both offline — ${s?.state}`);

  // Bob's claim is the BTC (fromLeg) leg — the fee-driven one. Assert the watchtower picked the tier the
  // mocked fastest fee calls for, and that it's ABOVE the cheapest rung (i.e. it actually used the fee).
  const bobBundle = s.finish.bob.claim, wantTier = await pickTier("btc", bobBundle.tiers);
  const usedTier = s.wt?.["bob:claim"]?.tier;
  console.log(`  bob BTC-claim ladder feerates: [${bobBundle.tiers.map((t) => t.feerate).join(", ")}] sat/vB; picked tier ${usedTier} (=${bobBundle.tiers[usedTier]?.feerate} sat/vB)`);
  chk(usedTier === wantTier, `watchtower broadcast at the fastest-fee tier (${usedTier} === pickTier ${wantTier})`);
  chk(usedTier > 0, `it climbed the ladder for the expensive mempool (tier ${usedTier} > lowest)`);

  console.log(`\n=== ${ok ? "PASS" : "FAIL"} — watchtower sizes its broadcast to the live fastest fee ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
