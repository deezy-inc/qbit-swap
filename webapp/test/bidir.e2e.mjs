// Bidirectional end-to-end: run a full swap through the SwapClient + coordinator on regtest for BOTH
// creator intents — creator BUYS QBT (creator is alice/initiator) and creator SELLS QBT (the JOINER
// becomes alice/initiator). Proves either side can CREATE the swap while the QBT buyer is ALWAYS the
// initiator (sole secret-holder, fromLeg=btc), no matter who created the link.
//   Run:  (source deploy/lab.env) DEV_CONFS_CAP=2 node test/bidir.e2e.mjs
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

// creatorRole: "alice" = creator buys QBT (initiates); "bob" = creator sells QBT (the joiner initiates).
async function runCreatorRole(creatorRole) {
  const buys = creatorRole === "alice";
  console.log(`\n--- creator role ${creatorRole}: creator ${buys ? "BUYS" : "SELLS"} QBT ${buys ? "(creator initiates)" : "(joiner initiates)"} ---`);
  const dests = async () => ({ btcDest: await btc.rpcWallet("alice", "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet("bob", "getnewaddress") });
  const creator = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.actionError && console.log("  [creator] err:", v.actionError) });
  const joiner  = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.actionError && console.log("  [joiner] err:", v.actionError) });

  const { id, inviteToken } = await creator.create({ role: creatorRole, btcSats: 100000000, qbtSats: 500000000, securityLevel: "high", ...(await dests()) });
  await joiner.join({ id, token: inviteToken, ...(await dests()) });
  console.log(`  created ${id.slice(0, 10)}; creator role=${creator.role} (secret=${!!creator.secret}); joiner role=${joiner.role} (secret=${!!joiner.secret})`);

  // Security invariant: the QBT buyer is alice and the SOLE secret-holder, regardless of who created.
  const buyer = creator.role === "alice" ? creator : joiner;
  const seller = creator.role === "alice" ? joiner : creator;
  if (buyer.role !== "alice" || !buyer.secret || seller.secret) throw new Error(`SECURITY: QBT buyer must be the sole initiator (buyer.role=${buyer.role}, buyer.secret=${!!buyer.secret}, seller.secret=${!!seller.secret})`);

  creator.start(); joiner.start();
  const ready = await (async () => { for (let i = 0; i < 60; i++) { if (creator.view?.htlc) return creator.view; await sleep(500); } throw new Error("no READY"); })();
  if (ready.roles.fromLeg !== "btc" || ready.roles.toLeg !== "qbit") throw new Error(`legs must be btc(from)->qbit(to), got ${JSON.stringify(ready.roles)}`);
  console.log(`  fromLeg=${ready.roles.fromLeg} (locktime ${ready.locktimes.btc}), toLeg=${ready.roles.toLeg} (locktime ${ready.locktimes.qbit}), confsTarget=${ready.confsTarget?.confs}`);

  // fund each leg from whichever wallet holds that coin (btc<-alice, qbit<-bob)
  await btc.rpcWallet("alice", "sendtoaddress", ready.htlc.btc.address, 1); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", ready.htlc.qbit.address, 5); await qmineTo(1);
  await bmine(2); await qmineTo(2);

  const end = Date.now() + 100000;
  while (Date.now() < end) { await bmine(1); await qmineTo(1); if (creator.view?.state === "COMPLETE") break; await sleep(1500); }
  creator.stop(); joiner.stop();
  const ok = creator.view?.state === "COMPLETE" && joiner.view?.state === "COMPLETE";
  console.log(`  buyer(alice) claimed qbit: ${!!buyer.view?.broadcasts?.["qbit:claim"]}; seller(bob) claimed btc: ${!!seller.view?.broadcasts?.["btc:claim"]}`);
  console.log(`  ${ok ? "PASS" : "FAIL"} — reached ${creator.view?.state}`);
  return ok;
}

async function main() {
  await startServer(PORT);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 20) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);
  const a = await runCreatorRole("alice");   // creator buys QBT
  const b = await runCreatorRole("bob");     // creator sells QBT -> joiner initiates
  console.log(`\n=== ${a && b ? "PASS" : "FAIL"} — both creator roles settle with the QBT buyer as initiator ===`);
  process.exit(a && b ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
