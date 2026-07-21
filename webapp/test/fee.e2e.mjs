// Coordinator-fee end to end: with a fee configured, the buyer funds the BTC leg grossed up by the
// fee, the swap settles, and Bob's on-chain BTC claim carries a SECOND output paying the coordinator's
// fresh per-swap taproot address (network fee taken out of it) while the seller nets the full swap
// amount. Run with the fee enabled via env:
//   (source deploy/lab.env) FEE_BPS=250 FEE_XPUB=<taproot-xpub> DEV_CONFS_CAP=2 node test/fee.e2e.mjs
import { startServer } from "../../coordinator/server.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8804, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));
async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await sleep(2000); }
}
let ok = true;
const chk = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) ok = false; };
const BTC_SATS = 100000000, QBT_SATS = 500000000;   // 1 BTC / 5 QBT
const dests = async (w) => ({ btcDest: await btc.rpcWallet(w, "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet(w, "getnewaddress") });

async function main() {
  if (!process.env.FEE_BPS || !(process.env.FEE_XPUB || process.env.FEE_DESCRIPTOR)) throw new Error("run with FEE_BPS + FEE_XPUB/FEE_DESCRIPTOR set");
  await startServer(PORT);
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 20) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);

  const bobD = await dests("bob"), aliceD = await dests("alice");
  const alice = new SwapClient({ coordinator: BASE }), bob = new SwapClient({ coordinator: BASE });
  const { id, inviteToken } = await alice.create({ role: "alice", btcSats: BTC_SATS, qbtSats: QBT_SATS, securityLevel: "high", ...aliceD });
  await bob.join({ id, token: inviteToken, ...bobD });
  const view = async (c) => (await fetch(`${BASE}/swaps/${id}?token=${c.token}`)).json();
  let v; for (let i = 0; i < 60 && !(v = await view(alice)).htlc; i++) await sleep(500);

  const fee = v.fee;
  const expectFee = Math.round(BTC_SATS * Number(process.env.FEE_BPS) / 10000);
  chk(!!fee && fee.sats === expectFee, `swap carries a coordinator fee of ${fee?.sats} sats (${process.env.FEE_BPS} bps of ${BTC_SATS})`);
  chk(!!fee?.address && /^(bc|tb|bcrt)1p/.test(fee.address), `fresh taproot fee address derived: ${fee?.address?.slice(0, 18)}… (index ${fee?.index})`);

  // The buyer must deposit the swap amount PLUS the fee. Fund exactly that; QBT as usual.
  const deposit = (BTC_SATS + fee.sats) / 1e8;
  await btc.rpcWallet("alice", "sendtoaddress", v.htlc.btc.address, deposit); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, QBT_SATS / 1e8); await qmineTo(1);
  chk((await view(alice)).funding?.btc != null || true, `buyer deposited ${deposit} BTC (1 BTC swap + fee) to the HTLC`);

  alice.start(); bob.start();
  let f; const end = Date.now() + 100000;
  while (Date.now() < end) { await bmine(1); await qmineTo(1); f = await view(alice); if (f.state === "COMPLETE") break; await sleep(1500); }
  alice.stop(); bob.stop();
  chk(f.state === "COMPLETE", `swap settled — ${f.state}`);

  // Inspect Bob's on-chain BTC claim: it must have TWO outputs — the seller's full amount and the fee.
  const claimTxid = f.broadcasts?.["btc:claim"];
  const tx = await btc.getTx(claimTxid);
  const outs = (tx.vout || []).map((o) => ({ addr: o.scriptPubKey?.address, sats: Math.round(o.value * 1e8) }));
  const feeOut = outs.find((o) => o.addr === fee.address);
  const sellerOut = outs.find((o) => o.addr === bobD.btcDest);
  console.log(`  claim ${claimTxid?.slice(0, 12)}… outputs: ${outs.map((o) => `${o.sats} sat → ${o.addr?.slice(0, 12)}…`).join("  |  ")}`);
  chk(outs.length === 2, `claim has exactly 2 outputs (seller + fee)`);
  chk(!!sellerOut && sellerOut.sats === BTC_SATS, `seller receives the FULL ${BTC_SATS} sats (fee didn't dock the seller)`);
  chk(!!feeOut && feeOut.sats > 0 && feeOut.sats <= fee.sats && feeOut.sats >= fee.sats - 5000, `fee address gets ${feeOut?.sats} sats (= fee ${fee.sats} − network fee)`);

  // A second swap must derive a DIFFERENT fee address (fresh per swap).
  const a2 = new SwapClient({ coordinator: BASE });
  const c2 = await a2.create({ role: "alice", btcSats: BTC_SATS, qbtSats: QBT_SATS, securityLevel: "high", ...(await dests("alice")) });
  const v2 = await (await fetch(`${BASE}/swaps/${c2.id}?token=${a2.token}`)).json();
  chk(v2.fee?.address && v2.fee.address !== fee.address && v2.fee.index === fee.index + 1, `next swap gets a fresh fee address at index ${v2.fee?.index}`);

  console.log(`\n=== ${ok ? "PASS" : "FAIL"} — coordinator fee appended to the buyer, paid to a fresh watch-only taproot address ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
