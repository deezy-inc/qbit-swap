// Pre-paid network-fee RESERVE (swap.js:feeNetSats). It must be DYNAMIC — scale with the live fastest-fee
// rate — and buffered (aggressive) so a claim can outbid a spike. Pure function; no chain/network.
// Run:  node fee.test.mjs
process.env.COORD_CHAIN = "dev";     // no real chain adapter
process.env.FEE_NET_BUFFER = "3";    // pin the buffer for deterministic expectations
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const { feeNetSats } = await import("./swap.js");

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const VB = 208, BUF = 3;   // BTC claim + fee-output vbytes · buffer

ck(feeNetSats(2) === Math.ceil(VB * 2 * BUF), `feeNetSats(2) = ${feeNetSats(2)} (208·2·3 = 1248)`);
ck(feeNetSats(50) === Math.ceil(VB * 50 * BUF), `feeNetSats(50) = ${feeNetSats(50)} (208·50·3 = 31200)`);
ck(feeNetSats(0) === Math.ceil(VB * 1 * BUF) && feeNetSats(undefined) === feeNetSats(0), `floors the rate at 1 → ${feeNetSats(0)}`);
// DYNAMIC: linear in the fee rate — doubling the rate doubles the reserve.
ck(feeNetSats(20) === 2 * feeNetSats(10), `dynamic: feeNetSats(20)=${feeNetSats(20)} == 2×feeNetSats(10)=${2 * feeNetSats(10)}`);
// Monotonic increasing — a higher live rate always reserves more.
ck(feeNetSats(200) > feeNetSats(50) && feeNetSats(50) > feeNetSats(10) && feeNetSats(10) > feeNetSats(2), "monotonic in the fee rate");
// Aggressive: buffered well above a single-rate estimate.
ck(feeNetSats(10) === Math.ceil(VB * 10) * BUF || feeNetSats(10) > VB * 10, `buffered above the raw estimate (208·10=${VB * 10} < ${feeNetSats(10)})`);

console.log(ok ? "\nPASS — the network-fee reserve is dynamic + buffered" : "\nFAIL");
process.exit(ok ? 0 : 1);
