// Funding-confirmation gate e2e: the buyer must NOT be able to reveal the preimage (claim the QBT
// leg) while their BTC deposit is still unconfirmed — otherwise, once the secret is public, the seller
// claims a BTC funding tx the buyer can still RBF away, keeping both coins. We fund QBT and mature it
// but leave BTC at 0-conf, and prove: state stays MATURING, the coordinator refuses the early claim,
// no preimage leaks; then confirming BTC opens the gate and the swap completes (with no lingering
// "in mempool").  Run:  (source deploy/lab.env) DEV_CONFS_CAP=2 node test/gate.e2e.mjs
import { startServer } from "../../coordinator/server.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8802, BASE = `http://127.0.0.1:${PORT}`;
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
  const view = async (c) => (await fetch(`${BASE}/swaps/${id}?token=${c.token}`)).json();
  let v; for (let i = 0; i < 60 && !(v = await view(alice)).htlc; i++) await sleep(500);
  if (!v.htlc) throw new Error("HTLCs never derived");

  // Mature the QBT (toLeg) leg, but fund BTC and leave it in the mempool (0-conf, RBF-able).
  await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, 5); await qmineTo(3);
  await btc.rpcWallet("alice", "sendtoaddress", v.htlc.btc.address, 1);   // NOT mined
  let g; for (let i = 0; i < 90; i++) { g = await view(alice); if (g.funding?.btc && (g.funding?.qbit?.confs || 0) >= g.confsTarget.confs) break; await sleep(1000); }
  console.log(`  QBT confs ${g.funding?.qbit?.confs}/${g.confsTarget.confs}; BTC unconfirmed=${g.funding?.btc?.unconfirmed}; fromConfsTarget=${g.fromConfsTarget?.confs}`);
  chk(g.funding?.btc?.unconfirmed === true, "BTC deposit is seen at 0-conf (in mempool)");
  chk((g.funding?.qbit?.confs || 0) >= g.confsTarget.confs, "QBT deposit is matured to its reorg-safe depth");
  chk(g.state === "MATURING", `state HELD at MATURING while BTC unconfirmed (not CLAIMABLE) — got ${g.state}`);

  // Buyer attempts to reveal the preimage early → coordinator must refuse (qbit has no other relay).
  const sweep = await alice.buildSweep(g, "claim");
  const r = await fetch(`${BASE}/swaps/${id}/broadcast`, { method: "POST", headers: { "content-type": "application/json", "x-swap-token": alice.token }, body: JSON.stringify({ leg: sweep.leg, kind: "claim", tx: sweep.hex }) });
  const j = await r.json();
  chk(!r.ok && /safe depth/i.test(j.error || ""), `early QBT claim REJECTED by coordinator (${r.status}: ${j.error})`);
  chk(!(await view(alice)).preimage, "no preimage leaked — the seller's BTC stays un-RBF-safe until it confirms");

  // Confirm the BTC funding → the gate opens.
  await bmine(1);
  let c; for (let i = 0; i < 60; i++) { c = await view(alice); if (c.state === "CLAIMABLE") break; await sleep(1000); }
  chk(c.state === "CLAIMABLE", `once BTC confirms, state advances to CLAIMABLE — got ${c.state}`);
  chk(c.funding?.btc?.unconfirmed === false, "BTC deposit now shows confirmed (no lingering 'in mempool')");

  // The same claim now succeeds; drive to COMPLETE.
  alice.start(); bob.start();
  let f; const end = Date.now() + 90000;
  while (Date.now() < end) { await bmine(1); await qmineTo(1); f = await view(alice); if (f.state === "COMPLETE") break; await sleep(1500); }
  alice.stop(); bob.stop();
  chk(f.state === "COMPLETE", `swap completes after the gate opens — ${f.state}`);
  chk(f.funding?.btc?.unconfirmed === false, "final BTC funding is confirmed (mempool tag cleared at completion)");

  console.log(`\n=== ${ok ? "PASS" : "FAIL"} — preimage reveal is gated on BTC funding confirmation ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
