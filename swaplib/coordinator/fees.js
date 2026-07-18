// mempool.space recommended Bitcoin feerates (sat/vB), cached (default ~90s). The watchtower uses
// these to pick/escalate which pre-signed fee-ladder tier to broadcast for a Bitcoin claim/refund.
const URL = (process.env.MEMPOOL_URL || "https://mempool.space/api").replace(/\/$/, "");
const TTL = Number(process.env.FEES_TTL_MS || 90000);
let cache = null, at = 0;

export async function btcFeerates() {
  if (cache && Date.now() - at < TTL) return cache;
  try {
    const r = await fetch(`${URL}/v1/fees/recommended`);
    if (r.ok) { cache = await r.json(); at = Date.now(); }
  } catch { /* keep last good value */ }
  // fallback (e.g. regtest / offline): 1 sat/vB → the watchtower picks the lowest pre-signed tier
  return cache || { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
}
