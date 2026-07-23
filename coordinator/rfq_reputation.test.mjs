// RFQ reputation / fill-rate tests: fault-aware classification (a maker isn't blamed when the TAKER
// fails to fund first), fill-rate aggregation, and auto-suspension after repeated recent no-shows +
// its removal from the book. Drives outcomes by mutating the swap objects takeRfq creates (no chain).
// Run:  node rfq_reputation.test.mjs
process.env.COORD_CHAIN = "dev";
process.env.RFQ_MAKER_KEYS = "good:k-good,flaky:k-flaky";
process.env.RFQ_REP_GRACE_MS = "1000000000";   // huge → "still-active + unfunded" never auto-counts as no-show in this test; we use terminal states to force it
process.env.RFQ_REP_SUSPEND = "3";
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const { makerByKey, submitQuote, bestQuote, takeRfq, makerRep, makerSuspended, depth } = await import("./rfq.js");
const { getSwap } = await import("./swap.js");

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const G = makerByKey("k-good"), F = makerByKey("k-flaky");

// Force a match to a SPECIFIC maker by quoting only that maker on the side we take.
function matchTo(maker, side, qbtSats, price) {
  for (const m of [G, F]) submitQuote(m, { ask: null, bid: null });    // clear both
  submitQuote(maker, side === "buy" ? { ask: { price, qbtSats: qbtSats * 10 } } : { bid: { price, qbtSats: qbtSats * 10 } });
  const take = takeRfq({ side, qbtSats, price });
  return getSwap(take.swapId);
}
// Outcome helpers — mutate the created swap to simulate on-chain reality.
const complete = (s) => { s.state = "COMPLETE"; s.funding = { btc: { spent: true }, qbit: { spent: true } }; };
const makerFunded = (s, leg) => { s.funding = { ...(s.funding || {}), [leg]: { amountSats: 1 } }; };   // maker's leg funded, swap in flight
const clearTaker = (s) => { s.fromConfirmedAt = Date.now(); };                                         // taker's BTC buried (ask maker now cleared to fund)
const refundedNoFund = (s) => { s.state = "REFUNDED"; };                                               // ended with the maker's leg never funded

// ── a good maker: buy (maker=bob funds qbit=toLeg) ───────────────────────────────────────────────
{
  const s = matchTo(G, "buy", 1e8, 0.2);
  complete(s);
  const r = makerRep(G);
  ck(r.completed === 1 && r.fillRate === 1, "completed swap → fillRate 1.0");
}
// maker funded but the swap is still in flight → counts as delivered
{
  const s = matchTo(G, "buy", 1e8, 0.2); clearTaker(s); makerFunded(s, "qbit");
  const r = makerRep(G);
  ck(r.funded === 2 && r.noShow === 0, "funded-but-inflight counts as delivered, not a no-show");
}

// ── NOT the maker's fault: taker never funded their BTC first (ask maker never cleared) ───────────
{
  const s = matchTo(G, "buy", 1e8, 0.2); refundedNoFund(s);   // terminal, maker unfunded, but fromConfirmedAt never set
  const r = makerRep(G);
  ck(r.noShow === 0 && r.notAttributed === 1, "taker-abort (maker never cleared to fund) is NOT charged to the maker");
  ck(r.fillRate === 1, "fill rate unchanged by a taker-abort");
}

// ── the maker's fault: cleared to fund, ended, never funded → no-show ─────────────────────────────
{
  const s = matchTo(F, "buy", 1e8, 0.2); clearTaker(s); refundedNoFund(s);
  const r = makerRep(F);
  ck(r.noShow === 1 && r.fillRate === 0, "cleared-but-unfunded terminal → no-show, fillRate 0");
}
// A bid maker (maker=alice) funds FIRST, so it's always "cleared": an unfunded terminal is its fault.
{
  const s = matchTo(F, "sell", 1e8, 0.18); refundedNoFund(s);
  const r = makerRep(F);
  ck(r.noShow === 2, "bid maker is always cleared (funds first) → unfunded terminal is a no-show");
}

// ── suspension: 3rd recent no-show suspends the maker and drops it from the book ─────────────────
ck(!makerSuspended(F), "flaky maker not yet suspended at 2 no-shows");
{
  const s = matchTo(F, "sell", 1e8, 0.18); refundedNoFund(s);   // 3rd no-show
  ck(makerRep(F).recentNoShow === 3 && makerSuspended(F), "3rd recent no-show → suspended");
}
// Suspended maker is excluded from quoting: put BOTH makers on the buy side, the flaky one is dropped.
submitQuote(G, { ask: { price: 0.2, qbtSats: 5e8 } });
submitQuote(F, { ask: { price: 0.1, qbtSats: 5e8 } });   // better price, but suspended → must be ignored
{
  const d = depth().buy;
  ck(d.makers === 1 && d.price === 0.2, "suspended maker excluded from depth (its better price is not offered)");
  const q = bestQuote("buy", { qbtSats: 1e8 });
  ck(q._maker === G, "bestQuote routes to the healthy maker, never the suspended one");
}

// The good maker's clean record leaves it live and quotable throughout.
ck(!makerSuspended(G) && makerRep(G).fillRate === 1, "good maker stays live with fillRate 1.0");

console.log(ok ? "\nPASS — fault-aware fill-rate, no-show attribution, and auto-suspension all hold" : "\nFAIL");
process.exit(ok ? 0 : 1);
