// Bidirectional end-to-end: run a full swap in BOTH directions through the SwapClient + coordinator
// on regtest. Proves either side can initiate.  Run:  DEV_CONFS_CAP=2 node test/bidir.e2e.mjs
import { startServer } from "../../coordinator/server.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await sleep(2000); }
}

async function runDirection(dir) {
  console.log(`\n--- direction ${dir} ---`);
  const dests = async () => ({ btcDest: await btc.rpcWallet("alice", "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet("bob", "getnewaddress") });
  const aliceDest = await dests(), bobDest = await dests();
  const alice = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.actionError && console.log("  [alice] err:", v.actionError) });
  const bob = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.actionError && console.log("  [bob] err:", v.actionError) });

  const { id, bobToken } = await alice.create({ direction: dir, btcSats: 100000000, qbtSats: 500000000, securityLevel: "high", ...aliceDest });
  const { direction } = await bob.join({ id, token: bobToken, ...bobDest });
  console.log(`  created ${id.slice(0, 10)}; participant sees direction=${direction}`);
  alice.start(); bob.start();
  const ready = await (async () => { for (let i = 0; i < 60; i++) { if (alice.view?.htlc) return alice.view; await sleep(500); } throw new Error("no READY"); })();
  console.log(`  fromLeg=${ready.roles.fromLeg} (locktime ${ready.locktimes[ready.roles.fromLeg]}), toLeg=${ready.roles.toLeg} (locktime ${ready.locktimes[ready.roles.toLeg]})`);

  // fund each leg from whichever wallet holds that coin (btc<-alice, qbit<-bob)
  await btc.rpcWallet("alice", "sendtoaddress", ready.htlc.btc.address, 1); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", ready.htlc.qbit.address, 5); await qmineTo(1);
  await bmine(2); await qmineTo(2);

  const end = Date.now() + 100000;
  while (Date.now() < end) { await bmine(1); await qmineTo(1); if (alice.view?.state === "COMPLETE") break; await sleep(1500); }
  alice.stop(); bob.stop();
  const ok = alice.view?.state === "COMPLETE";
  console.log(`  initiator claimed ${ready.roles.toLeg}: ${!!alice.view?.broadcasts?.[ready.roles.toLeg + ":claim"]}; participant claimed ${ready.roles.fromLeg}: ${!!bob.view?.broadcasts?.[ready.roles.fromLeg + ":claim"]}`);
  console.log(`  ${ok ? "PASS" : "FAIL"} — ${dir} reached ${alice.view?.state}`);
  return ok;
}

async function main() {
  await startServer(PORT);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 20) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);
  const a = await runDirection("btc2qbt");
  const b = await runDirection("qbt2btc");
  console.log(`\n=== ${a && b ? "PASS" : "FAIL"} — both swap directions work ===`);
  process.exit(a && b ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
