// Watchtower fee-ladder tier selection (swap.js:pickTier). Mocks the mempool fee oracle, so it never
// touches the network or a chain.  Run:  node wtfee.test.mjs
process.env.FEES_TTL_MS = "0";     // no caching → every pickTier re-reads our mocked feerate
process.env.COORD_CHAIN = "dev";   // no real chain adapter needed

const fee = { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
globalThis.fetch = async (u) => {
  if (String(u).includes("fees/recommended")) return { ok: true, json: async () => fee };
  throw new Error("unexpected fetch: " + u);   // pickTier must hit nothing else
};
// Import AFTER env + fetch are set (fees.js reads FEES_TTL_MS at load; pickTier calls our fetch).
const { pickTier } = await import("./swap.js");

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const BTC = [2, 8, 25, 75, 200].map((f) => ({ feerate: f, tx: "" }));   // the client's BTC ladder
const QBT = [1, 5].map((f) => ({ feerate: f, tx: "" }));

fee.fastestFee = 1;   ck((await pickTier("btc", BTC)) === 0, "lowest tier when the mempool is cheap (1 → idx0)");
fee.fastestFee = 8;   ck((await pickTier("btc", BTC)) === 1, "exact-match tier (8 → idx1)");
fee.fastestFee = 30;  ck((await pickTier("btc", BTC)) === 3, "cheapest tier >= fastestFee (30 → 75 sat/vB, idx3)");
fee.fastestFee = 500; ck((await pickTier("btc", BTC)) === 4, "top tier when fees exceed the whole ladder");

// minIndex floors the choice so a re-send never downgrades below the tier already broadcast.
fee.fastestFee = 30;  ck((await pickTier("btc", BTC, 4)) === 4, "minIndex floors above the fee target (no downgrade)");
fee.fastestFee = 5;   ck((await pickTier("btc", BTC, 2)) === 2, "minIndex respected when fastestFee sits below it");
fee.fastestFee = 100; ck((await pickTier("btc", BTC, 1)) === 4, "minIndex is a floor, not a ceiling (fees still push higher)");

// Qbit has no external oracle → not fee-driven; always the lowest tier (or the minIndex floor).
fee.fastestFee = 999; ck((await pickTier("qbit", QBT)) === 0, "qbit is not fee-driven (lowest tier)");
                      ck((await pickTier("qbit", QBT, 1)) === 1, "qbit still honors the minIndex floor on re-send");

console.log("\n" + (ok ? "ALL PASS — watchtower fee-ladder tier selection" : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
