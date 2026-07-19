// Headless test of the esplora (mempool.space) BTC backend: response mapping + rate-limit retry.
// Mocks global fetch, so it never touches the network.  Run:  BTC_BACKEND=esplora node esplora.test.mjs
import assert from "node:assert";
process.env.BTC_BACKEND = "esplora";
process.env.ESPLORA_MIN_INTERVAL_MS = "1";   // keep the test fast

const calls = [];
let rateLimitOnce = true;
globalThis.fetch = async (url, opts = {}) => {
  calls.push(url);
  // simulate one 429 the first time we hit the utxo endpoint, to exercise retry/backoff
  if (url.includes("/scripthash/") && rateLimitOnce) { rateLimitOnce = false; return { status: 429, headers: new Map([["retry-after", "0"]]), ok: false, text: async () => "rate limited" }; }
  const json = (o) => ({ status: 200, ok: true, json: async () => o, text: async () => (typeof o === "string" ? o : JSON.stringify(o)) });
  if (url.endsWith("/blocks/tip/height")) return json("870123");
  if (url.includes("/scripthash/")) return json([{ txid: "aa".repeat(32), vout: 1, value: 100000000, status: { confirmed: true, block_height: 870000 } }]);
  if (url.includes("/outspend/")) return json({ spent: false });
  if (url.includes("/tx/") && !url.endsWith("/tx")) return json({ vin: [{ witness: ["sig", "preimage", "01"] }], vout: [], status: { confirmed: true, block_height: 870005 } });
  if (url.endsWith("/tx") && opts.method === "POST") return json("broadcasttxid");
  throw new Error("unexpected url " + url);
};

const { btc } = await import("./chain.js");
assert.equal(btc.backend, "esplora", "btc uses esplora backend");

assert.equal(await btc.height(), 870123, "height maps /blocks/tip/height");

const out = await btc.findOutput("0014" + "11".repeat(20));
assert.deepEqual(out, { txid: "aa".repeat(32), vout: 1, amountSats: 100000000, height: 870000 }, "findOutput maps scripthash utxo (value in sats)");
assert.ok(calls.filter((u) => u.includes("/scripthash/")).length === 2, "retried once after the 429");

assert.equal(await btc.isUnspent("aa".repeat(32), 1), true, "isUnspent maps outspend.spent");
assert.deepEqual(await btc.testAccept("00"), { allowed: true }, "testAccept is a no-op precheck on esplora");
assert.equal(await btc.broadcast("00ff"), "broadcasttxid", "broadcast POSTs raw hex -> txid");

const tx = await btc.getTx("bb".repeat(32));
assert.deepEqual(tx.vin[0].txinwitness, ["sig", "preimage", "01"], "getTx maps Esplora witness -> txinwitness (preimage extraction unchanged)");

console.log("esplora backend: ALL PASS (mapping + rate-limit retry)");
