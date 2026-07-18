// Order-book end-to-end on regtest: a maker posts an ask, a taker takes it from the public book, both
// enter the instantiated swap (taker = initiator), fund, and it settles to COMPLETE.
// Run:  (source deploy/lab.env) DEV_CONFS_CAP=2 node test/orderbook.e2e.mjs
import { startServer } from "../../coordinator/server.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { SwapClient } from "../src/swapflow.js";

const PORT = 8796, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.m || "GET", headers: { "content-type": "application/json" }, body: o.b ? JSON.stringify(o.b) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
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
  console.log("=== order book: maker posts asks, taker buys one ===\n");

  // Maker posts three asks (sell QBT for BTC) at different lot sizes.
  const lots = [[500000000, 100000000], [1000000000, 205000000], [2500000000, 500000000]];
  const posted = [];
  for (const [give, want] of lots) posted.push(await api("/offers", { m: "POST", b: { giveCoin: "QBT", giveSats: give, wantCoin: "BTC", wantSats: want } }));
  const book = await api("/offers");
  console.log("book asks:", book.asks.map((a) => `${a.giveSats / 1e8} QBT @ ${a.price.toFixed(4)} BTC/QBT`).join("  |  "));

  // Taker clicks the best ask.
  const best = book.asks[0];
  const offerId = best.id, makerToken = posted.find((p) => p.id === offerId).makerToken;
  const take = await api(`/offers/${offerId}/take`, { m: "POST" });
  console.log(`\n[taker] took ${offerId.slice(0, 8)} -> swap ${take.swapId.slice(0, 8)} (${take.direction}); buys ${take.terms.qbtSats / 1e8} QBT for ${take.terms.btcSats / 1e8} BTC`);

  // Taker enters as initiator (alice). Maker discovers the take and enters as participant (bob).
  const takerDests = { btcDest: await btc.rpcWallet("alice", "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet("alice", "getnewaddress") };
  const makerDests = { btcDest: await btc.rpcWallet("bob", "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet("bob", "getnewaddress") };
  const taker = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.actionError && console.log("[taker] err:", v.actionError) });
  const maker = new SwapClient({ coordinator: BASE, onUpdate: (v) => v.actionError && console.log("[maker] err:", v.actionError) });
  await taker.enter({ id: take.swapId, token: take.takerToken, direction: take.direction, role: "alice", ...takerDests });
  const mv = await api(`/offers/${offerId}?makerToken=${makerToken}`);
  await maker.enter({ id: mv.take.swapId, token: mv.take.makerSwapToken, direction: take.direction, role: "bob", ...makerDests });
  console.log("[maker] fulfilled the take (entered as participant)");
  taker.start(); maker.start();

  const ready = await (async () => { for (let i = 0; i < 60; i++) { if (taker.view?.htlc) return taker.view; await sleep(500); } throw new Error("no READY"); })();
  // Fund: taker sends BTC (initiator, longer timelock), maker sends QBT.
  await btc.rpcWallet("alice", "sendtoaddress", ready.htlc.btc.address, ready.terms.btcSats / 1e8); await bmine(1);
  await qbit.rpcWallet("bob", "sendtoaddress", ready.htlc.qbit.address, ready.terms.qbtSats / 1e8); await qmineTo(1);
  await bmine(2); await qmineTo(2);
  console.log("[both] funded; waiting for auto-claim…");

  const end = Date.now() + 100000;
  while (Date.now() < end) { await bmine(1); await qmineTo(1); if (taker.view?.state === "COMPLETE") break; await sleep(1500); }
  taker.stop(); maker.stop();
  const ok = taker.view?.state === "COMPLETE";
  console.log(`\n=== ${ok ? "PASS" : "FAIL"} — order-book swap reached ${taker.view?.state} (taker bought QBT for BTC) ===`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
