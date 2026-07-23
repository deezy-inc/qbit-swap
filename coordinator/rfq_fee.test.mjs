// RFQ fee-incidence tests (fees ON): TAKER pays on both RFQ sides.
//   buy:  taker sends terms.btcSats + fee (engine gross-up) — maker receives the full terms.
//   sell: quote nets the fee out of the taker's BTC proceeds — the maker's all-in outlay
//         (terms.btcSats + fee.sats) never exceeds its quoted price × size.
// Also locks takerNetOfGross: maximal, and exact across the FEE_MIN_SATS floor boundary.
// Run:  node rfq_fee.test.mjs
process.env.COORD_CHAIN = "dev";
process.env.BTC_HRP = "bc";                          // FEE_NETWORK=mainnet, matching the test xpub
process.env.FEE_BPS = "200";                         // 2%
process.env.FEE_XPUB = "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
process.env.RFQ_MAKER_KEYS = "mm:feekey";
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const { feeTotalOn, takerNetOfGross, getSwap } = await import("./swap.js");
const { makerByKey, submitQuote, bestQuote, takeRfq } = await import("./rfq.js");

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };

// With no live feerate cache (no network), the reserve is 208 vB × 1 sat/vB × 3 = 624 sats.
const NET = 624;
ck(feeTotalOn(1e8) === Math.round(1e8 * 0.02) + NET, "feeTotalOn = 2% platform + network reserve");
ck(feeTotalOn(10000) === NET, "below the FEE_MIN_SATS floor only the reserve is charged");

// takerNetOfGross: b + fee(b) ≤ gross, and b is MAXIMAL — swept across sizes incl. the floor boundary
// (platform cut ≈ FEE_MIN_SATS at b ≈ 50k sats) and awkward rounding points.
{
  let maximal = true, fits = true;
  for (const gross of [60000, 100000, 300000, 1000000, 5000000, 49000 + NET, 51000 + NET, 1234567, 99999999, 12345678901]) {
    const b = takerNetOfGross(gross);
    if (b + feeTotalOn(b) > gross) fits = false;
    if (b + 1 + feeTotalOn(b + 1) <= gross) maximal = false;
  }
  ck(fits, "takerNetOfGross: net + fee(net) never exceeds the gross (maker never overpays its quote)");
  ck(maximal, "takerNetOfGross: maximal (the taker isn't shorted a single recoverable sat)");
}

// ── through the RFQ layer ────────────────────────────────────────────────────
const M = makerByKey("feekey");
submitQuote(M, { ask: { price: 0.2, qbtSats: 100e8 }, bid: { price: 0.19, qbtSats: 100e8 } });

// BUY: unchanged — terms carry the full price; the engine's gross-up puts the fee on the taker.
const qb = bestQuote("buy", { qbtSats: 10e8 });
ck(qb.btcSats === Math.ceil(10e8 * 0.2), "buy: terms.btcSats = full price (taker pays the fee ON TOP via the engine gross-up)");
const buy = takeRfq({ side: "buy", qbtSats: 10e8, price: 0.2 });
const sBuy = getSwap(buy.swapId);
ck(sBuy.fee?.sats === feeTotalOn(sBuy.terms.btcSats), "buy: the swap carries the fee, funded by the taker (BTC sender)");

// SELL (qbt given): taker proceeds are net; maker outlay ≤ quoted price × size.
const gross = Math.floor(10e8 * 0.19);
const qs = bestQuote("sell", { qbtSats: 10e8 });
ck(qs.btcSats === takerNetOfGross(gross), "sell: quoted btcSats = taker's NET proceeds");
const sell = takeRfq({ side: "sell", qbtSats: 10e8, price: 0.19 });
const sSell = getSwap(sell.swapId);
const outlay = sSell.terms.btcSats + (sSell.fee?.sats || 0);
ck(outlay <= gross, `sell: maker all-in outlay ${outlay} ≤ quoted ${gross} (maker pays its price, not the fee)`);
ck(gross - outlay <= 1, "sell: and within a sat of it (no value stranded)");
ck(sSell.terms.btcSats < gross, "sell: the taker's proceeds bear the fee (net < gross)");

// SELL (btc given): "I want to net b BTC" — QBT sized to cover b + fee, maker outlay ≤ qbt × bid.
const b = 1e8;
const qs2 = bestQuote("sell", { btcSats: b });
ck(qs2.btcSats === b && qs2.qbtSats === Math.ceil((b + feeTotalOn(b)) / 0.19), "sell(btc-given): QBT sized to cover net + fee");
ck(b + feeTotalOn(b) <= Math.floor(qs2.qbtSats * 0.19), "sell(btc-given): maker outlay still within its quoted price for that size");

console.log(ok ? "\nPASS — RFQ fees are taker-pays on both sides; makers pay exactly their quote" : "\nFAIL");
process.exit(ok ? 0 : 1);
