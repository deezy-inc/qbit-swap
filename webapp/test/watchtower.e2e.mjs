// Watchtower end-to-end: both parties fund, pre-sign their fee-ladder claim + refund (arm the safety
// net), then CLOSE THEIR TABS (clients stopped). The coordinator must drive the swap to COMPLETE on
// its own — broadcasting the initiator's pre-signed claim (revealing the preimage) and splicing that
// preimage into the participant's pre-signed claim.  Run: (source deploy/lab.env) DEV_CONFS_CAP=2 node test/watchtower.e2e.mjs
import { startServer } from "../../coordinator/server.js";
import { getSwap } from "../../coordinator/swap.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// read state directly from the in-process store — an authed HTTP GET would mark the party "online" and
// (correctly) hold the watchtower back, since the watchtower only steps in for an offline party.
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await sleep(2000); }
}

async function main() {
  await startServer(PORT);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 20) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);
  console.log("=== watchtower: parties arm, close tabs, coordinator finishes ===\n");

  const dests = async (w) => ({ btcDest: await btc.rpcWallet(w, "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet(w, "getnewaddress") });
  const alice = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.safetyNet === "armed" && console.log("[alice] safety net armed ✓") });
  const bob = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.safetyNet === "armed" && console.log("[bob]   safety net armed ✓") });
  const created = await alice.create({ role: "alice", btcSats: 100000000, qbtSats: 500000000, securityLevel: "high", ...(await dests("alice")) });
  await bob.join({ id: created.id, token: created.inviteToken, ...(await dests("bob")) });
  alice.start(); bob.start();

  const ready = await (async () => { for (let i = 0; i < 60; i++) { if (alice.view?.htlc) return alice.view; await sleep(500); } throw new Error("no READY"); })();
  await btc.rpcWallet("alice", "sendtoaddress", ready.htlc.btc.address, 1); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", ready.htlc.qbit.address, 5); await qmineTo(1);
  console.log("[both] funded; waiting for both to pre-sign…");

  // wait until the coordinator holds BOTH pre-signed bundles
  await (async () => { for (let i = 0; i < 60; i++) { const s = getSwap(created.id); if (s?.finish?.alice && s?.finish?.bob) return; await sleep(1000); } throw new Error("both parties never armed"); })();
  console.log("[coord] holds both pre-signed safety nets\n");

  // *** CLOSE BOTH TABS *** — from here the clients do nothing; only the coordinator can finish it.
  alice.stop(); bob.stop();
  console.log("[test] both clients STOPPED (tabs closed). Coordinator must finish alone (after presence grace).\n");
  await qmineTo(2);   // mature the QBT leg -> CLAIMABLE, so the watchtower reveals

  let s, done = false; const end = Date.now() + 120000;
  while (Date.now() < end) { await bmine(1); await qmineTo(1); s = getSwap(created.id); if (s.state === "COMPLETE") { done = true; break; } await sleep(2000); }
  const v = s;
  const wtClaimedQbit = !!v?.broadcasts?.["qbit:claim"], wtClaimedBtc = !!v?.broadcasts?.["btc:claim"];
  console.log(`[coord] watchtower broadcast — qbit claim (reveal): ${wtClaimedQbit}; btc claim (spliced preimage): ${wtClaimedBtc}`);
  console.log(`\n=== ${done ? "PASS" : "FAIL"} — coordinator drove the swap to ${v?.state} with both tabs closed ===`);
  process.exit(done ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
