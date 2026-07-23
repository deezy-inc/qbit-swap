// API e2e: a RETAIL order too big for any one maker, routed across several via /rfq/order, funded by a
// SINGLE deposit that fans out into every leg's BTC HTLC, and driven to settlement by the real in-browser
// SwapClient on both sides — all against the live coordinator HTTP API (in-memory chain stands in for the
// offline regtest nodes). Scenarios: full multi-maker fill, a partial fill when the book is thin, and the
// aggregate (VWAP) limit reject.  Run:  node test/rfq_order.e2e.mjs
import { randomBytes } from "node:crypto";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { slhDsaKeygen, compressedPub, htlcLeafQbit, p2mrAddress, splitterAddress, splitFunding } from "@qbit-swap/client";
import { SwapClient } from "../src/swapflow.js";
import { installMocks } from "./mockchain.mjs";

process.env.COORD_CHAIN = "dev";
process.env.BTC_BLOCK_SECS = "1"; process.env.QBIT_BLOCK_SECS = "1";
process.env.HTLC_TO_SECS = "60"; process.env.HTLC_FROM_SECS = "120";
process.env.DEV_CONFS_CAP = "2"; process.env.FUNDING_WINDOW_MS = "600000"; process.env.RATE_MAX = "100000";
process.env.FEE_BPS = "200";
process.env.FEE_XPUB = "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
process.env.RFQ_MAKER_KEYS = "mA:kA,mB:kB,mC:kC";
const { startServer } = await import("../../coordinator/server.js");
const { qbit, btc } = await import("../../coordinator/chain.js");
const mock = installMocks(qbit, btc);

const PORT = 8804, BASE = `http://127.0.0.1:${PORT}`;
const HRP = { btcHrp: "bcrt", qbitHrp: "qbrt" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry transient connection errors (undici keep-alive races under many in-process pollers hitting one
// server — a test artifact; a real browser has its own connection per client). HTTP errors don't retry.
async function api(p, o = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(BASE + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(o.token ? { "x-swap-token": o.token } : {}), ...(o.key ? { "x-maker-key": o.key } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
      const j = await r.json(); if (!r.ok) { const e = new Error(j.error || r.status); e.body = j; throw e; } return j;
    } catch (e) { if (e.body || attempt >= 5) throw e; await sleep(50); }   // e.body ⇒ a real HTTP error; otherwise a transient fetch failure → retry
  }
}
const until = async (fn, ms = 300, tries = 300) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch { /* transient — keep polling */ } await sleep(ms); } throw new Error("until: timeout"); };
let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };

// Throwaway valid receive/refund addresses (any decodable address on the right chain works — the mock
// doesn't validate ownership; the client only needs to build a claim output to them).
const newBtcDest = () => splitterAddress(randomBytes(32), "bcrt").address;
let _qd;
async function qbitDest() { if (_qd) return _qd; const kp = await slhDsaKeygen(randomBytes(128)); _qd = p2mrAddress(htlcLeafQbit(sha256(randomBytes(32)), kp.pk, kp.pk, 100), "qbrt"); return _qd; }

// Maker key by the swap's price (so we can drive each match's maker leg); set of live maker quotes.
const MAKERS = [{ key: "kA", ask: 0.20, size: 3e8 }, { key: "kB", ask: 0.21, size: 3e8 }, { key: "kC", ask: 0.25, size: 10e8 }];
const pingAll = async () => Promise.all(MAKERS.map((m) => api("/rfq/maker", { method: "POST", key: m.key, body: { ask: { price: m.ask, qbtSats: m.size } } })));

// Drive one maker leg (Bob): join, fund QBT once the taker's BTC buries, let the client auto-claim BTC.
// `noShow` simulates a maker that matches but never funds — its leg must then refund, not complete.
async function driveMaker(match, noShow = false) {
  let funded = false;
  const c = new SwapClient({ coordinator: BASE, ...HRP, onUpdate: async (v) => {
    if (!noShow && !funded && v.htlc && v.fundGate?.cleared && !v.funding?.qbit) { funded = true; mock.qbit.fundSpk(v.htlc.qbit.spk, v.terms.qbtSats); mock.qbit.mine(2); }
  } });
  await c.enter({ id: match.swapId, token: match.token, direction: "btc2qbt", role: "bob", btcDest: newBtcDest(), qbitDest: await qbitDest() });
  c.start();
  return c;
}
// Drive one taker leg (Alice): join and auto-claim QBT on reveal. Funding is the shared fan-out below.
async function driveTaker(leg) {
  const c = new SwapClient({ coordinator: BASE, ...HRP, onUpdate: () => {} });
  await c.enter({ id: leg.swapId, token: leg.token, direction: "btc2qbt", role: "alice", btcDest: newBtcDest(), qbitDest: await qbitDest() });
  c.start();
  return c;
}
// The heart of it: fund EVERY leg's BTC HTLC from ONE user deposit → one fan-out tx.
async function fanoutFund(legTokens) {
  const views = await Promise.all(legTokens.map((t) => until(async () => { const v = await api(`/swaps/${swapOf(t)}`, { token: t }); return v.htlc ? v : null; })));
  const outputs = views.map((v) => ({ spk: bin(v.htlc.btc.spk), value: v.terms.btcSats + (v.fee?.sats || 0) }));
  const total = outputs.reduce((n, o) => n + o.value, 0), fee = 1000;
  const priv = randomBytes(32), dep = splitterAddress(priv, "bcrt");
  const depTxid = mock.btc.fundSpk(hex(dep.spk), total + fee);                       // the user's single deposit
  const { txHex } = splitFunding({ prevTxidLE: bin(depTxid).reverse(), vout: 0, amount: total + fee, priv, outputs });
  await mock.btc.broadcast(txHex); mock.btc.mine(2);                                 // browser fan-out into all N BTC HTLCs
  return { legs: views.length, total };
}
const _swapByToken = new Map();
const swapOf = (token) => _swapByToken.get(token);
const legState = (l) => api(`/swaps/${l.swapId}`, { token: l.token });

// Take an order and drive every leg: makers (Bob) + takers (Alice) join, then ONE fan-out deposit funds
// all the BTC legs. `noShowSwapIds` marks maker legs that will match but never fund (for the mixed case).
async function driveOrder({ side = "buy", qbtSats, btcSats, price, noShowSwapIds = [] }) {
  const order = await api("/rfq/order", { method: "POST", body: { side, qbtSats, btcSats, price } });
  order.legs.forEach((l) => _swapByToken.set(l.token, l.swapId));
  const orderIds = new Set(order.legs.map((l) => l.swapId));
  const matches = (await Promise.all(MAKERS.map((m) => api("/rfq/maker", { method: "POST", key: m.key, body: {} })))).flatMap((r) => r.matches).filter((m) => orderIds.has(m.swapId));
  const makerClients = await Promise.all(matches.map((m) => driveMaker(m, noShowSwapIds.includes(m.swapId))));
  const takerClients = await Promise.all(order.legs.map(driveTaker));
  await fanoutFund(order.legs.map((l) => l.token));
  return { order, makerClients, takerClients, stop: () => [...makerClients, ...takerClients].forEach((c) => c.stop()) };
}

async function main() {
  await startServer(PORT);

  // ── scenario 1: 7-QBT buy routed across 3 makers, one deposit funds all legs → all COMPLETE ──────
  console.log("\n=== scenario 1: multi-maker order (3 legs), single fan-out deposit → all COMPLETE ===");
  await pingAll();
  const plan = await api("/rfq/plan?side=buy&qbtSats=700000000");
  ck(plan.legs.length === 3 && plan.complete, `plan routes 7 QBT across ${plan.legs.length} makers (complete)`);
  {
    const { order, stop } = await driveOrder({ qbtSats: 7e8, price: 0.25 });
    ck(order.legs.length === 3 && order.orderId, "order opened 3 legs under one orderId");
    const finals = await Promise.all(order.legs.map((l) => until(async () => { const v = await legState(l); return v.state === "COMPLETE" ? v : null; }, 300, 400)));
    ck(finals.every((v) => v.state === "COMPLETE"), "every leg settled COMPLETE from the single fan-out deposit");
    ck(finals.reduce((n, v) => n + v.terms.qbtSats, 0) === 7e8, "taker received the full 7 QBT across the order");
    stop();
  }

  // ── scenario 2: order larger than the book → partial fill; the legs that DO route all settle ──────
  console.log("\n=== scenario 2: order exceeds the book → partial fill, filled legs COMPLETE ===");
  await pingAll();                                          // book = 3+3+10 = 16 QBT
  {
    const p = await api("/rfq/plan?side=buy&qbtSats=2500000000");   // ask for 25 QBT
    ck(!p.complete && p.qbtSats === 16e8, "plan reports a partial fill of all 16 QBT available (complete=false)");
    const { order, stop } = await driveOrder({ qbtSats: 25e8, price: 0.25 });
    ck(order.qbtSats === 16e8 && !order.complete, "order fills the available 16 QBT and flags the partial");
    const finals = await Promise.all(order.legs.map((l) => until(async () => { const v = await legState(l); return v.state === "COMPLETE" ? v : null; }, 300, 400)));
    ck(finals.every((v) => v.state === "COMPLETE"), "every routed leg of the partial order settled COMPLETE");
    stop();
  }

  // ── scenario 3: aggregate (VWAP) limit — a limit below the plan VWAP is rejected, no swaps created ─
  console.log("\n=== scenario 3: VWAP limit reject ===");
  await pingAll();
  {
    const p = await api("/rfq/plan?side=buy&qbtSats=700000000");
    let moved;
    try { await api("/rfq/order", { method: "POST", body: { side: "buy", qbtSats: 7e8, price: p.price - 0.001 } }); }
    catch (e) { moved = e; }
    ck(moved?.body && /price moved/.test(moved.message), "limit below the VWAP → 409 price moved");
    ck(moved.body.quote && moved.body.quote.legs?.length === 3, "reject returns the fresh multi-leg plan for a re-quote");
  }

  // ── scenario 4: one maker no-shows → its leg refunds while the others COMPLETE (partial settlement) ─
  console.log("\n=== scenario 4: a maker no-shows → mixed order (some COMPLETE, one REFUNDED) ===");
  await pingAll();
  {
    const order = await api("/rfq/order", { method: "POST", body: { side: "buy", qbtSats: 7e8, price: 0.25 } });
    order.legs.forEach((l) => _swapByToken.set(l.token, l.swapId));
    const dud = order.legs[0].swapId;                       // this maker will take the match but never fund
    const orderIds = new Set(order.legs.map((l) => l.swapId));
    const matches = (await Promise.all(MAKERS.map((m) => api("/rfq/maker", { method: "POST", key: m.key, body: {} })))).flatMap((r) => r.matches).filter((m) => orderIds.has(m.swapId));
    const makerClients = await Promise.all(matches.map((m) => driveMaker(m, m.swapId === dud)));
    const takerClients = await Promise.all(order.legs.map(driveTaker));
    await fanoutFund(order.legs.map((l) => l.token));       // all legs' BTC funded from one deposit
    // the two good legs complete; the dud leg can't (no QBT) → advance past its BTC timelock so the taker refunds
    const good = order.legs.filter((l) => l.swapId !== dud);
    await Promise.all(good.map((l) => until(async () => { const v = await legState(l); return v.state === "COMPLETE" ? v : null; }, 300, 500)));
    ck(true, "the two funded legs settled COMPLETE");
    const dv = await legState(order.legs.find((l) => l.swapId === dud));
    mock.btc.mine((dv.locktimes.btc - mock.btc.height) + 1);   // BTC timelock passes → taker reclaims the dud leg's deposit
    const refunded = await until(async () => { const v = await legState(order.legs.find((l) => l.swapId === dud)); return v.state === "REFUNDED" ? v : null; }, 300, 500);
    ck(refunded.state === "REFUNDED", "the no-show leg refunded the taker's fanned-out BTC (partial settlement, no funds lost)");
    [...makerClients, ...takerClients].forEach((c) => c.stop());
  }

  console.log(ok ? "\nPASS — multi-maker orders: full fill, partial fill, VWAP reject, and no-show refund — all over the live API" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
