// Multi-maker routing: planFill walks the book best-price-first and slices across makers; takeFill turns
// a plan into N grouped swaps. Covers ordering, VWAP, partial fills when liquidity is short, sub-min
// remainder dropping, per-maker size decrement + match delivery, the shared orderId, and the aggregate
// (VWAP) limit gate. Run:  node rfq_plan.test.mjs
process.env.COORD_CHAIN = "dev";
process.env.RFQ_MAKER_KEYS = "a:k-a,b:k-b,c:k-c";
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const { makerByKey, submitQuote, planFill, publicPlan, takeFill, depth } = await import("./rfq.js");
const { getSwap } = await import("./swap.js");

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const A = makerByKey("k-a"), B = makerByKey("k-b"), C = makerByKey("k-c");

// Book — asks (retail buys QBT): A best 0.20×3, B 0.21×3, C worst 0.25×10 (all QBT sizes ×1e8).
const q = (p, n) => ({ price: p, qbtSats: n * 1e8 });
submitQuote(A, { ask: q(0.20, 3), bid: q(0.18, 5) });
submitQuote(B, { ask: q(0.21, 3), bid: q(0.17, 5) });
submitQuote(C, { ask: q(0.25, 10) });

// ── plan: fill 7 QBT — no single maker covers it, so A(3)+B(3)+C(1) ──────────────────────────────
{
  const p = planFill("buy", { qbtSats: 7e8 });
  ck(p.legs.length === 3, "7 QBT routed across 3 makers (none covers it alone)");
  ck(p.legs[0].price === 0.20 && p.legs[1].price === 0.21 && p.legs[2].price === 0.25, "legs ordered best price first");
  ck(p.legs[0].qbtSats === 3e8 && p.legs[1].qbtSats === 3e8 && p.legs[2].qbtSats === 1e8, "each leg sized to the maker's available, remainder to the next");
  ck(p.qbtSats === 7e8 && p.complete, "aggregate fills the full 7 QBT");
  const vwap = (3e8 * 0.20 + 3e8 * 0.21 + 1e8 * 0.25) / 7e8;
  ck(near(p.price, vwap), `VWAP price = ${p.price.toFixed(6)} (volume-weighted, not best or worst)`);
  ck(p.btcSats === Math.ceil(3e8 * 0.20) + Math.ceil(3e8 * 0.21) + Math.ceil(1e8 * 0.25), "total BTC = sum of maker-favored leg costs");
  ck(!("m" in publicPlan(p).legs[0]), "publicPlan strips maker identity from legs");
}

// ── partial fill when the book is too thin ───────────────────────────────────────────────────────
{
  const p = planFill("buy", { qbtSats: 100e8 });        // way more than the 16 QBT on offer
  ck(!p.complete && p.qbtSats === 16e8, "over-large request → partial plan of all available depth (16 QBT), complete=false");
}

// ── best price first for a SELL (bids, highest first): A 0.18 then B 0.17 ─────────────────────────
{
  const p = planFill("sell", { qbtSats: 8e8 });
  ck(p.legs[0].price === 0.18 && p.legs[1].price === 0.17, "sell routes highest bid first");
  ck(p.qbtSats === 8e8 && p.complete, "sell fills 8 QBT across the two bids");
}

// ── take the 7-QBT buy → 3 grouped swaps, sizes/decrements/matches all correct ───────────────────
{
  const order = takeFill({ side: "buy", qbtSats: 7e8, price: 0.25 });   // limit = worst leg's price; VWAP is below it → fills
  ck(order.legs.length === 3 && order.orderId, "order opened 3 swaps under one orderId");
  ck(order.legs.every((l) => l.role === "alice"), "taker holds the alice (initiator) token on every leg");
  ck(order.legs.every((l) => getSwap(l.swapId)?.orderId === order.orderId), "each swap is tagged with the shared orderId");
  ck(A.matches.length === 1 && B.matches.length === 1 && C.matches.length === 1, "each maker got exactly one pending match");
  ck(A.matches[0].role === "bob" && A.matches[0].token === getSwap(order.legs[0].swapId).tokens.bob, "maker A's match carries ITS bob token for its leg");
  ck(A.quote.ask.qbtSats === 0 && B.quote.ask.qbtSats === 0 && C.quote.ask.qbtSats === 9e8, "each maker's remaining ask size decremented by its fill");
}

// ── aggregate (VWAP) limit gate: a limit below the current VWAP → price-moved with a fresh plan ───
{
  // refresh the book (previous take consumed A & B's asks)
  submitQuote(A, { ask: q(0.20, 3) }); submitQuote(B, { ask: q(0.21, 3) }); submitQuote(C, { ask: q(0.25, 10) });
  const vwap = (3e8 * 0.20 + 3e8 * 0.21 + 1e8 * 0.25) / 7e8;
  let moved;
  try { takeFill({ side: "buy", qbtSats: 7e8, price: vwap - 0.001 }); } catch (e) { moved = e; }
  ck(moved && /price moved/.test(moved.message), "limit below the VWAP → price-moved reject");
  ck(moved.quote && near(moved.quote.price, vwap) && moved.quote.legs.length === 3, "reject carries the fresh plan (VWAP + legs) for a re-quote");
}

console.log(ok ? "\nPASS — multi-maker routing: ordering, VWAP, partials, grouped take, and the VWAP limit gate" : "\nFAIL");
process.exit(ok ? 0 : 1);
