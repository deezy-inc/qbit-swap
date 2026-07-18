// Coordinator HTTP API (keyless, non-custodial) + chain watcher. REST/JSON; a bot and the browser app
// drive swaps through the same endpoints. Auth is a per-party capability token (X-Swap-Token).
// Live updates over Server-Sent Events (GET /swaps/:id/events). Basic per-IP rate limiting.
import http from "node:http";
import { createSwap, getSwap, roleOf, submitParty, broadcast, view, poll, allSwaps, subscribe, markSeen, addConnection, dropConnection, sweepPresence } from "./swap.js";
import { createOffer, getOffer, isMaker, book, takeOffer, cancelOffer, makerView } from "./offers.js";
import { btc } from "./chain.js";

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });

// ── rate limit: sliding window per IP (protects create + write endpoints) ─────
const WINDOW_MS = 60_000, MAX_HITS = Number(process.env.RATE_MAX || 120);
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now); hits.set(ip, arr);
  return arr.length > MAX_HITS;
}

function sse(req, res, s, role) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (sw) => res.write(`data: ${JSON.stringify(view(sw, role))}\n\n`);
  const unsub = subscribe(s.id, send);
  send(s);                                              // initial snapshot
  addConnection(s.id, role);                            // mark online -> notifies the counterparty
  const hb = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(hb); unsub(); dropConnection(s.id, role); });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);   // ["swaps", id, action?]
  const method = req.method;
  const ip = req.socket.remoteAddress || "?";
  // CORS: the browser app is served from a different origin than the coordinator.
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("access-control-allow-headers", "content-type, x-swap-token");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    if (method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, swaps: allSwaps().length });
    if (method !== "GET" && rateLimited(ip)) return json(res, 429, { error: "rate limited" });

    if (method === "POST" && url.pathname === "/swaps") {
      const b = await readBody(req);
      if (!(b.btcSats > 0) || !(b.qbtSats > 0)) return json(res, 400, { error: "btcSats and qbtSats required" });
      const s = createSwap({ btcSats: b.btcSats, qbtSats: b.qbtSats, securityLevel: b.securityLevel, direction: b.direction });
      return json(res, 201, { id: s.id, tokens: s.tokens });   // Alice shares tokens.bob as Bob's link
    }

    // ── order book ────────────────────────────────────────────────────────────
    if (parts[0] === "offers") {
      if (method === "GET" && !parts[1]) return json(res, 200, book());                          // public book
      if (method === "POST" && !parts[1]) { const o = createOffer(await readBody(req)); return json(res, 201, { id: o.id, makerToken: o.makerToken }); }
      if (parts[1]) {
        const o = getOffer(parts[1]);
        if (!o) return json(res, 404, { error: "no such offer" });
        if (method === "POST" && parts[2] === "take") return json(res, 201, takeOffer(o));        // anyone can take
        const mtok = req.headers["x-maker-token"] || url.searchParams.get("makerToken") || "";     // maker-only below
        if (!isMaker(o, mtok)) return json(res, 401, { error: "maker token required" });
        if (method === "GET" && !parts[2]) return json(res, 200, makerView(o));
        if (method === "POST" && parts[2] === "cancel") return json(res, 200, makerView(cancelOffer(o)));
      }
    }

    if (parts[0] === "swaps" && parts[1]) {
      const s = getSwap(parts[1]);
      if (!s) return json(res, 404, { error: "no such swap" });
      const role = roleOf(s, req.headers["x-swap-token"] || url.searchParams.get("token") || "");
      if (!role) return json(res, 401, { error: "bad or missing X-Swap-Token" });
      markSeen(s.id, role);   // any authenticated hit = this party is online (covers browser + bot)

      if (method === "GET" && !parts[2]) return json(res, 200, view(s, role));
      if (method === "GET" && parts[2] === "events") return sse(req, res, s, role);
      if (method === "POST" && parts[2] === "party") { await submitParty(s, role, await readBody(req)); return json(res, 200, view(s, role)); }
      if (method === "POST" && parts[2] === "broadcast") {
        const b = await readBody(req);
        const r = await broadcast(s, b.leg, b.kind, b.tx);
        return json(res, 200, r);
      }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
}

let watching = false;
async function watchTick() {
  for (const s of allSwaps()) { try { await poll(s); } catch { /* transient chain error */ } }
}
// Purge settled swaps' descriptors from the BTC watch-only wallet (rpc/pruned-node backend) so it
// doesn't grow unbounded. A descriptor is KEPT while its swap could still need watching:
//   - the swap is non-terminal — this covers the ENTIRE recovery/refund window, which may be long
//     (a swap awaiting a timelocked refund stays non-terminal until the refund actually lands); and
//   - for a settle-grace afterward, so we never drop right at the terminal transition (e.g. a
//     both-funded abort where one party refunds — flipping the swap to REFUNDED — while the other's
//     leg is still unspent and awaiting its own, possibly much later, refund).
// (Defense in depth: even a dropped descriptor never risks funds — parties refund with their own keys
// and the coordinator broadcasts from the mempool; the wallet is only for funding *detection*.)
const SETTLE_GRACE_MS = Number(process.env.WATCH_SETTLE_GRACE_MS || 86400000);   // 24h
async function cleanupWatch() {
  if (btc.backend !== "rpc" || btc.watch !== "wallet") return;   // only the watch-only-wallet path accumulates descriptors
  const now = Date.now();
  const keep = allSwaps().filter((s) => s.htlc?.btc?.spk && (
    !["COMPLETE", "REFUNDED", "ABORTED"].includes(s.state) ||   // active OR still in the recovery window
    !s.settledAt || now - s.settledAt < SETTLE_GRACE_MS         // recently settled -> grace before dropping
  )).map((s) => s.htlc.btc.spk);
  try { await btc.pruneWatch(keep); } catch { /* node transient */ }
}

export function startServer(port = 8787) {
  const server = http.createServer(handle);
  return new Promise((resolve) => server.listen(port, () => {
    if (!watching) { watching = true; setInterval(watchTick, 2000); setInterval(sweepPresence, 4000); setInterval(cleanupWatch, Number(process.env.WATCH_CLEANUP_MS || 21600000)); }  // cleanup check every 6h; rotation is count-gated
    resolve(server);
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) startServer(Number(process.env.PORT) || 8787).then((s) => console.log("coordinator on", s.address()));
