// Coordinator-down BTC broadcast fallback (swapflow.js). Two layers:
//   1) postRawTx() endpoint failover — pure, fast, with an injected fetch.
//   2) integration: drive the real SwapClient via a mocked SSE view so #act -> #claim -> #send runs;
//      the coordinator /broadcast fails, and the BTC leg must fall back to a public endpoint.
import { SwapClient, postRawTx, BTC_BROADCAST } from "../src/swapflow.js";
import { htlcWitnessScript } from "@qbit-swap/client";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";

let pass = true;
const ck = (name, ok, extra = "") => { console.log(`[${ok ? "ok" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`); pass = pass && ok; };
const okResp = (txt) => ({ ok: true, text: async () => txt });
const errResp = (status, txt) => ({ ok: false, status, text: async () => txt });

// ── 1) postRawTx failover ───────────────────────────────────────────────────
{
  const hits = [];
  const fetchImpl = async (url) => { hits.push(url); return url.includes("mempool") ? errResp(400, "bad") : okResp("TXID_A"); };
  const txid = await postRawTx(["https://mempool.space/api/tx", "https://blockstream.info/api/tx"], "deadbeef", fetchImpl);
  ck("postRawTx falls through to the 2nd endpoint when the 1st rejects", txid === "TXID_A" && hits.length === 2, `txid=${txid}`);
}
{
  const txid = await postRawTx(["https://a/tx"], "aa", async () => okResp("  TXID_TRIMMED\n"));
  ck("postRawTx returns the trimmed txid", txid === "TXID_TRIMMED");
}
{
  let threw = false;
  try { await postRawTx(["https://a/tx", "https://b/tx"], "aa", async () => { throw new Error("net down"); }); }
  catch { threw = true; }
  ck("postRawTx throws when every endpoint fails", threw);
}
ck("mainnet has broadcast endpoints; regtest has none", BTC_BROADCAST.bc.length >= 1 && !BTC_BROADCAST.bcrt);

// ── 2) integration: coordinator /broadcast down → BTC leg falls back ──────────
// Bob claims the BTC (fromLeg) with the public preimage. ECDSA only (no WASM needed).
function mkView() {
  const H = sha256(new Uint8Array(32).fill(0x11));
  const claimPub = new Uint8Array(33); claimPub[0] = 0x02; claimPub.fill(0x11, 1);
  const refundPub = new Uint8Array(33); refundPub[0] = 0x03; refundPub.fill(0x22, 1);
  const ws = htlcWitnessScript(H, claimPub, refundPub, 500);
  return {
    state: "CLAIMED", roles: { fromLeg: "btc", toLeg: "qbit" },
    htlc: { btc: { witnessScript: hex(ws) }, qbit: { spk: "00", leaf: "00" } },
    funding: { btc: { txid: "11".repeat(32), vout: 0, amountSats: 100000 }, qbit: null },   // qbit null → skips armSafetyNet (no WASM)
    preimage: "11".repeat(32),
    feerates: { btc: { fastestFee: 5, halfHourFee: 3, minimumFee: 1 }, qbit: { fastestFee: 1, minimumFee: 1 } },
    broadcasts: {},
  };
}
async function driveOnce(fetchImpl) {
  const view = mkView();
  globalThis.EventSource = class { constructor() { queueMicrotask(() => this.onmessage({ data: JSON.stringify(view) })); } close() {} };
  globalThis.fetch = fetchImpl;
  let update = null;
  const c = new SwapClient({ coordinator: "https://coord.example/coord", btcHrp: "bc", onUpdate: (v) => { if (v.broadcastFallback) update = v; } });
  c.role = "bob"; c.id = "swap1"; c.token = "tok"; c.btcDest = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  c.btcPriv = new Uint8Array(32).fill(7);
  c.start();
  // #api retries a failing coordinator ~5 times with backoff (~5s) before it gives up and the fallback
  // runs — wait past that so we observe the end state, not a mid-retry snapshot.
  await new Promise((r) => setTimeout(r, 6500));
  return { c, update };
}

{
  // coordinator /broadcast throws; mempool accepts → fallback used, acted stays marked
  const seen = [];
  const { c, update } = await driveOnce(async (url, opts) => {
    seen.push(url);
    if (url.includes("/broadcast")) throw new Error("coordinator down");
    if (url.includes("mempool.space")) return okResp("FALLBACK_TXID");
    return okResp("");
  });
  
  const hitMempool = seen.some((u) => u.includes("mempool.space"));
  ck("coordinator down → BTC claim broadcast via public endpoint", hitMempool);
  ck("onUpdate surfaced broadcastFallback with the txid", update?.broadcastFallback?.leg === "btc" && update?.broadcastFallback?.txid === "FALLBACK_TXID");
  ck("leg stays marked acted after a successful fallback", c.acted.has("btc:claim"));
  c.stop();
}
{
  // coordinator down AND all public endpoints down → total failure, leg un-marked so #act can retry
  const { c } = await driveOnce(async (url) => {
    if (url.includes("/broadcast")) throw new Error("coordinator down");
    throw new Error("network down");
  });
  
  ck("total broadcast failure leaves the leg un-acted (retryable)", !c.acted.has("btc:claim"));
  c.stop();
}

console.log("\n" + (pass ? "ALL PASS — coordinator-down BTC broadcast fallback" : "FAILURES ABOVE"));
process.exit(pass ? 0 : 1);
