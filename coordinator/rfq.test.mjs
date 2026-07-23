// RFQ layer unit tests: maker auth, quote TTL (liquidity drops when a bot stops pinging), best-price
// aggregation across makers, maker-favored rounding, take → swap with correct role assignment, size
// decrement, price-moved (limit) rejection, and match delivery until the maker joins.
// Run:  node rfq.test.mjs
process.env.COORD_CHAIN = "dev";
process.env.RFQ_TTL_MS = "150";                       // tiny TTL so the expiry test is fast
process.env.RFQ_MAKER_KEYS = "mmA:key-alpha,mmB:key-beta";
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const { rfqEnabled, makerByKey, submitQuote, pendingMatches, depth, bestQuote, publicQuote, takeRfq, rfqStatus } = await import("./rfq.js");
const { getSwap, submitParty } = await import("./swap.js");

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const throws = (fn, re, m) => { try { fn(); ck(false, `${m} (no throw)`); return null; } catch (e) { ck(re.test(e.message), `${m} — "${e.message}"`); return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── auth ─────────────────────────────────────────────────────────────────────
const A = makerByKey("key-alpha"), B = makerByKey("key-beta");
ck(rfqEnabled(), "rfq enabled when RFQ_MAKER_KEYS is set");
ck(A?.name === "mmA" && B?.name === "mmB", "makerByKey resolves each configured key to its maker");
ck(makerByKey("wrong") === null && makerByKey("") === null, "unknown/empty key → null (server 401s)");

// ── quoting semantics ────────────────────────────────────────────────────────
// mmA: two-sided. ask 0.20 BTC/QBT × 50 QBT; bid 0.18 × 40 QBT. mmB: ask only, better price 0.19 × 10.
submitQuote(A, { ask: { price: 0.20, qbtSats: 50e8 }, bid: { price: 0.18, qbtSats: 40e8 } });
submitQuote(B, { ask: { price: 0.19, qbtSats: 10e8 } });
throws(() => submitQuote(B, { ask: { price: -1, qbtSats: 1e8 } }), /price must be > 0/, "negative price rejected");
throws(() => submitQuote(B, { bid: { price: 0.2, qbtSats: 0 } }), /qbtSats must be > 0/, "zero size rejected");
submitQuote(B, {});                                    // bare keep-alive: sides carry forward
ck(B.quote.ask?.price === 0.19 && B.quote.bid === null, "bare {} ping keeps the previous quote (pure keep-alive)");

const d0 = depth();
ck(d0.buy.qbtSats === 60e8 && d0.buy.price === 0.19 && d0.buy.makers === 2, "buy depth aggregates asks; best = lowest ask");
ck(d0.sell.qbtSats === 40e8 && d0.sell.price === 0.18 && d0.sell.makers === 1, "sell depth = bids; best = highest bid");

// ── pricing: best maker for size, maker-favored rounding ─────────────────────
const q1 = bestQuote("buy", { qbtSats: 5e8 });         // fits mmB (10 QBT @ 0.19, the better ask)
ck(q1.price === 0.19 && q1.btcSats === Math.ceil(5e8 * 0.19), "small buy fills at the BEST ask; BTC rounded UP (maker-favored)");
const q2 = bestQuote("buy", { qbtSats: 20e8 });        // too big for mmB → falls to mmA @ 0.20
ck(q2.price === 0.20, "a size beyond the best maker's quote falls through to the next-best");
const q3 = bestQuote("sell", { btcSats: 1e8 });        // sell for exactly 1 BTC at bid 0.18 → QBT rounded UP
ck(q3.price === 0.18 && q3.qbtSats === Math.ceil(1e8 / 0.18), "sell given btcSats: retail's QBT in rounded UP (maker-favored)");
ck(!("_maker" in publicQuote(q1)), "publicQuote strips the internal maker ref");
throws(() => bestQuote("buy", { qbtSats: 1000e8 }), /not enough liquidity/, "size beyond ALL makers → not-enough-liquidity");
throws(() => bestQuote("buy", { qbtSats: 250000 }), /amount too small/, "a fill whose BTC leg lands below MIN_SATS is rejected");   // 0.0025 QBT × 0.19 ≈ 47.5k sats < 50k min

// ── take: swap + roles + match queue ─────────────────────────────────────────
const buy = takeRfq({ side: "buy", qbtSats: 5e8, price: 0.19 });
ck(buy.role === "alice", "retail BUY → taker is alice (the QBT buyer/initiator)");
const sBuy = getSwap(buy.swapId);
ck(sBuy && buy.token === sBuy.tokens.alice, "taker got the alice token");
const mm = pendingMatches(B);
ck(mm.length === 1 && mm[0].role === "bob" && mm[0].token === sBuy.tokens.bob && mm[0].side === "ask", "maker's ping delivers the match with ITS (bob) token");
ck(B.quote.ask.qbtSats === 5e8, "maker's remaining ask size decremented by the fill");
throws(() => takeRfq({ side: "buy", qbtSats: 8e8, price: 0.19 }), /price moved/, "remaining size can't cover at the limit price → price-moved reject");
const moved = (() => { try { takeRfq({ side: "buy", qbtSats: 8e8, price: 0.19 }); } catch (e) { return e; } })();
ck(moved?.quote?.price === 0.20, "the reject carries the fresh (re-priced) quote for the UI");

const sell = takeRfq({ side: "sell", qbtSats: 10e8, price: 0.18 });
ck(sell.role === "bob", "retail SELL → taker is bob (QBT seller); the MAKER is alice");
const sSell = getSwap(sell.swapId);
const am = pendingMatches(A);
ck(am.length === 1 && am[0].role === "alice" && am[0].token === sSell.tokens.alice, "sell match queued for the maker as alice");

// A match stops being delivered once the maker joins (submits its party data) — no ack needed.
await submitParty(sSell, "alice", { qbitPub: "q1", btcPub: "b1", btcDest: "bd1", qbitDest: "qd1", H: "aa".repeat(32) });
ck(pendingMatches(A).length === 0, "match no longer delivered after the maker joins the swap");

// ── status projection: no secrets ────────────────────────────────────────────
const st = JSON.stringify(rfqStatus());
ck(!st.includes("key-alpha") && !st.includes(sSell.tokens.alice) && !st.includes(sSell.tokens.bob), "rfqStatus leaks no maker keys or swap tokens");

// ── TTL: liquidity drops when a bot stops pinging ────────────────────────────
await sleep(200);                                      // > RFQ_TTL_MS with no re-ping
ck(depth().buy.qbtSats === 0 && depth().sell.qbtSats === 0, "quotes expire after the TTL — a silent bot's liquidity drops away");
throws(() => bestQuote("buy", { qbtSats: 1e8 }), /no liquidity/, "no live makers → no-liquidity");
submitQuote(A, {});                                    // one keep-alive ping restores mmA's standing quote
ck(depth().sell.qbtSats > 0, "a fresh ping brings the quote back");

console.log(ok ? "\nPASS — RFQ quoting, TTL, roles, sizing and match delivery all hold" : "\nFAIL");
process.exit(ok ? 0 : 1);
