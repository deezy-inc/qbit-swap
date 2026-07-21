// Pre-paid-fee BTC claim (swapflow.js:btcClaimSplit). The SELLER must ALWAYS net the full swap amount
// (funding − feeTotal), and the network fee we take must be CAPPED at feeTotal — so however high fees rise
// between quote and claim, they can never eat into the seller's amount. Pure function.
// Run:  node test/fee.test.mjs
import { btcClaimSplit } from "../src/swapflow.js";

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const DUST = 546;
const feeTotal = 2624, funding = 100000 + feeTotal, btcSats = funding - feeTotal;   // 100000 swap + 2624 reserve
const netFeeOf = (s) => funding - s.outVal - (s.feeOut || 0);   // the implied on-chain network fee

// Normal: network fee well under the reserve → the platform keeps the remainder as a fee output.
{ const s = btcClaimSplit(funding, 416, feeTotal);
  ck(s.outVal === btcSats && s.feeOut === feeTotal - 416 && netFeeOf(s) === 416, `normal: seller=${s.outVal}, feeOut=${s.feeOut}, netfee=${netFeeOf(s)}`); }

// Remainder would be dust → fee output dropped; the leftover becomes the network fee, seller still whole.
{ const s = btcClaimSplit(funding, 2200, feeTotal);
  ck(s.outVal === btcSats && s.feeOut === null && netFeeOf(s) === feeTotal, `dust remainder: seller=${s.outVal}, feeOut=${s.feeOut}, netfee=${netFeeOf(s)}`); }

// Exactly at the reserve → fee output zero/dropped, seller whole.
{ const s = btcClaimSplit(funding, feeTotal, feeTotal);
  ck(s.outVal === btcSats && s.feeOut === null && netFeeOf(s) === feeTotal, `at cap: seller=${s.outVal}`); }

// EXTREME spike: desired fee far above the reserve → CAPPED at the reserve, seller NOT reduced.
{ const s = btcClaimSplit(funding, 50000, feeTotal);
  ck(s.outVal === btcSats && netFeeOf(s) === feeTotal, `spike: seller=${s.outVal} (capped at reserve, not shorted)`); }

// Invariant across the whole range: seller amount is fixed and the network fee never exceeds the reserve.
{ let inv = true, minNet = Infinity, maxNet = -Infinity;
  for (let nf = 0; nf <= 6 * feeTotal; nf += 91) { const s = btcClaimSplit(funding, nf, feeTotal); const n = netFeeOf(s); minNet = Math.min(minNet, n); maxNet = Math.max(maxNet, n); if (s.outVal !== btcSats || n > feeTotal || n < 0 || (s.feeOut != null && s.feeOut <= DUST)) inv = false; }
  ck(inv, `invariant over netFee∈[0,6×]: outVal always ${btcSats}; network fee in [${minNet},${maxNet}] ≤ ${feeTotal}`); }

console.log(ok ? "\nPASS — the seller is never shorted; the network fee is capped at the pre-paid reserve" : "\nFAIL");
process.exit(ok ? 0 : 1);
