// Watchtower REFUND end to end. An aborted swap: the buyer (Alice) goes offline BEFORE the QBT leg is
// funded, so she never arms and never reveals a preimage; the seller (Bob) funds his QBT, arms his
// pre-signed (fee-laddered) refund, and closes his tab too. Once the QBT leg's timelock HEIGHT is
// reached, the coordinator must broadcast Bob's refund on his behalf — no client, no backup file.
//
// On the wall-clock question: the timelock is stored in the script as a BLOCK HEIGHT (the wall-clock
// window is converted to a block count at swap creation via the chain's block time), so on regtest we
// just mine the QBT chain up to that height — which is exactly what makes this testable at will.
//   Run:  (source deploy/lab.env) DEV_CONFS_CAP=2 node test/wtrefund.e2e.mjs
import { startServer } from "../../coordinator/server.js";
import { getSwap } from "../../coordinator/swap.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8805, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await sleep(2000); }
}
let ok = true;
const chk = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) ok = false; };
const until = async (fn, tries = 60, ms = 1000) => { for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(ms); } throw new Error("timeout"); };
const dests = async (w) => ({ btcDest: await btc.rpcWallet(w, "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet(w, "getnewaddress") });

async function main() {
  await startServer(PORT);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 20) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);

  const alice = new SwapClient({ coordinator: BASE }), bob = new SwapClient({ coordinator: BASE });
  const { id, inviteToken } = await alice.create({ role: "alice", btcSats: 1000000, qbtSats: 500000000, securityLevel: "high", ...(await dests("alice")) });
  await bob.join({ id, token: inviteToken, ...(await dests("bob")) });
  alice.start(); bob.start();
  const view = async (c) => (await fetch(`${BASE}/swaps/${id}?token=${c.token}`)).json();
  let v; for (let i = 0; i < 60 && !(v = await view(alice)).htlc; i++) await sleep(500);

  // Fund Alice's BTC, then take Alice OFFLINE before the QBT leg funds → she never arms, never claims.
  await btc.rpcWallet("alice", "sendtoaddress", v.htlc.btc.address, 0.01); await bmine(1);
  await until(async () => (await view(alice)).funding?.btc);
  alice.stop();
  await sleep(500);

  // Bob funds his QBT and arms his (fee-laddered) refund, then closes his tab too.
  await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, 5); await qmineTo(1);
  await until(async () => getSwap(id)?.finish?.bob?.refund?.tiers?.length);
  const s0 = getSwap(id);
  chk(!s0.finish.alice, "Alice never armed (went offline before the QBT leg funded)");
  chk((s0.finish.bob?.refund?.tiers?.length || 0) >= 1, `Bob armed a fee-laddered refund (${s0.finish.bob?.refund?.tiers?.length} tiers) — not a single fixed-fee tx`);
  bob.stop();

  // No preimage is possible (Alice can't claim; the watchtower holds no claim bundle for her). Advance
  // the QBT chain to the refund timelock height and let the coordinator refund Bob entirely on its own.
  console.log(`  QBT refund unlocks at height ${s0.locktimes.qbit} (chain at ${s0.heights?.qbit}); mining up to it…`);
  let s; const end = Date.now() + 150000;
  while (Date.now() < end) { await qmineTo(1); await bmine(1); s = getSwap(id); if (s.broadcasts?.["qbit:refund"] && s.funding.qbit.spent) break; await sleep(2000); }

  chk(!!s.broadcasts?.["qbit:refund"], `watchtower broadcast Bob's QBT refund on its own — ${s.broadcasts?.["qbit:refund"]?.slice(0, 12)}…`);
  chk(!!s.wt?.["bob:refund"], `recorded as a watchtower action (tier ${s.wt?.["bob:refund"]?.tier})`);
  chk(!s.preimage, "no preimage was ever revealed (a clean abort, not a completion)");
  chk(s.funding.qbit.spent === true, "Bob's QBT deposit is now spent by the refund");
  chk(s.state === "REFUNDED", `swap ended REFUNDED — ${s.state}`);

  console.log(`\n=== ${ok ? "PASS" : "FAIL"} — the watchtower broadcasts the pre-signed refund once the timelock height is reached ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
