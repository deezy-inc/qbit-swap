// Pre-maturity sweep e2e: what happens when each party tries to broadcast a sweep tx before it's
// mature. A REFUND is CLTV-locked to the leg's timelock height, so broadcasting it early must be
// rejected by the node as "non-final"; the SAME tx becomes valid once the chain reaches the timelock.
// A CLAIM carries no timelock (its "maturity" is only the coordinator's reorg-safe confirmation
// policy), so it is consensus-valid immediately. We prove all three against the real regtest nodes.
//   Run:  DEV_CONFS_CAP=2 node test/premature.e2e.mjs
import { startServer } from "../../coordinator/server.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8801, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await sleep(2000); }
}
const chainOf = (leg) => (leg === "btc" ? btc : qbit);
const nonFinal = (s) => /non-final|locktime|non-BIP68/i.test(s || "");

let ok = true;
const chk = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) ok = false; };

async function main() {
  await startServer(PORT);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 20) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);

  const dests = async () => ({ btcDest: await btc.rpcWallet("alice", "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet("bob", "getnewaddress") });
  // NOTE: we deliberately do NOT call client.start() — no auto-drive — so the swap sits at "both funded"
  // (no claim, no preimage revealed) while we probe the sweep txs by hand.
  const alice = new SwapClient({ coordinator: BASE });
  const bob = new SwapClient({ coordinator: BASE });
  const { id, bobToken } = await alice.create({ direction: "btc2qbt", btcSats: 100000000, qbtSats: 500000000, securityLevel: "high", ...(await dests()) });
  await bob.join({ id, token: bobToken, ...(await dests()) });

  const view = async (c) => (await fetch(`${BASE}/swaps/${id}?token=${c.token}`)).json();
  let v; for (let i = 0; i < 60 && !(v = await view(alice)).htlc; i++) await sleep(500);
  if (!v.htlc) throw new Error("HTLCs never derived");
  const { fromLeg, toLeg } = v.roles;
  console.log(`  swap ${id.slice(0, 10)}  fromLeg=${fromLeg} (CLTV ${v.locktimes[fromLeg]}), toLeg=${toLeg} (CLTV ${v.locktimes[toLeg]})`);

  // Fund both legs, then wait until the coordinator sees both funded.
  await btc.rpcWallet("alice", "sendtoaddress", v.htlc.btc.address, 1); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, 5); await qmineTo(1);
  await bmine(2); await qmineTo(2);
  for (let i = 0; i < 60 && !((v = await view(alice)).funding?.btc && v.funding?.qbit); i++) await sleep(1000);
  if (!(v.funding?.btc && v.funding?.qbit)) throw new Error("both legs never funded");
  console.log(`  both funded at heights btc=${v.heights.btc} qbit=${v.heights.qbit} — well below the timelocks`);

  // ── 1) each party's REFUND, broadcast before its timelock, must be rejected as non-final ──────
  const aRefund = await alice.buildSweep(v, "refund");   // alice funded fromLeg -> her refund is that leg
  const bRefund = await bob.buildSweep(v, "refund");     // bob funded toLeg
  console.log(`\n  premature REFUND attempts (chain far below the CLTV heights):`);
  for (const [who, party, sw] of [["alice", alice, aRefund], ["bob", bob, bRefund]]) {
    // (a) directly against the node
    const acc = await chainOf(sw.leg).testAccept(sw.hex);
    chk(!acc.allowed && nonFinal(acc.reason), `${who}'s ${sw.leg} refund rejected by the node — reason "${acc.reason}"`);
    // (b) through the coordinator's broadcast endpoint (what the app would call)
    const r = await fetch(`${BASE}/swaps/${id}/broadcast`, { method: "POST", headers: { "content-type": "application/json", "x-swap-token": party.token }, body: JSON.stringify({ leg: sw.leg, kind: "refund", tx: sw.hex }) });
    const j = await r.json();
    chk(!r.ok && nonFinal(j.error), `${who}'s refund rejected by the coordinator too (${r.status}: ${j.error})`);
  }
  // state must be untouched — a rejected premature refund changes nothing
  chk((await view(alice)).state !== "REFUNDED", "swap state unchanged by the rejected refunds");

  // ── 2) a CLAIM has no timelock — it is consensus-valid immediately (maturity there is coordinator
  //       policy, not consensus). Alice can build+relay her toLeg claim now; we only test-accept it. ──
  const aClaim = await alice.buildSweep(v, "claim");
  const claimAcc = await chainOf(aClaim.leg).testAccept(aClaim.hex);
  console.log(`\n  claim has no CLTV:`);
  chk(claimAcc.allowed, `alice's ${aClaim.leg} claim is accepted by the node right away (no timelock gate) — this is why claim maturity is a reorg-safe coordinator policy, not consensus`);

  // ── 3) positive control: mine the BTC leg to its timelock; the SAME refund tx is now valid ────────
  console.log(`\n  maturing the ${fromLeg}=btc leg to CLTV height ${v.locktimes.btc}:`);
  const h = await btc.height();
  if (v.locktimes.btc - h > 0) await bmine(v.locktimes.btc - h);
  const accMatured = await btc.testAccept(aRefund.hex);
  chk(accMatured.allowed, `after maturity the identical refund tx is accepted (allowed=${accMatured.allowed}) — the only thing that changed was the height`);
  const r = await fetch(`${BASE}/swaps/${id}/broadcast`, { method: "POST", headers: { "content-type": "application/json", "x-swap-token": alice.token }, body: JSON.stringify({ leg: "btc", kind: "refund", tx: aRefund.hex }) });
  const j = await r.json();
  chk(r.ok && !!j.txid, `matured refund broadcasts (txid ${String(j.txid).slice(0, 12)}…), state -> ${j.state}`);

  console.log(`\n=== ${ok ? "PASS" : "FAIL"} — premature sweeps rejected until timelock maturity ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
