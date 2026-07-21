// TRIAL deployment: one HTTPS origin (via `tailscale serve`) hosting the web app, the coordinator,
// and the trial faucet, with the regtest chains kept ticking — so a browser-only user can click
// through a full BTC(regtest)<->QBT(regtest) swap, including the encrypted backup (which needs a
// secure context). A single unified server serves the app and reverse-proxies /coord and /faucet.
// Run:  PUBLIC_URL=https://your-host DEV_CONFS_CAP=2 node deploy/trial.js   (then expose port 8080)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { startServer } from "../../coordinator/server.js";
import { startAdmin } from "../../coordinator/admin.js";
import { startFaucet } from "./faucet.js";
import { qbit, btc } from "../../coordinator/chain.js";
import { MIN_SATS } from "../../coordinator/swap.js";   // single source of truth for the min swap value (env-driven)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const WEB = Number(process.env.WEB_PORT || 8080), COORD = Number(process.env.COORD_PORT || 8787), FAUCET = Number(process.env.FAUCET_PORT || 8788);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".ico": "image/x-icon" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same-origin config: the app talks to /coord and /faucet on its own origin (no CORS, no mixed content).
const CONFIG = `<script>window.QBIT_COORDINATOR=${JSON.stringify(`${PUBLIC_URL}/coord`)};window.QBIT_TRIAL_FAUCET=${JSON.stringify(`${PUBLIC_URL}/faucet`)};window.QBIT_HRPS={"btc":"bcrt","qbit":"qbrt"};window.QBIT_MIN_SATS=${JSON.stringify(MIN_SATS)};${process.env.FEE_BPS ? `window.QBIT_FEE_BPS=${Number(process.env.FEE_BPS) || 0};` : ""}</script>`;

function proxy(req, res, port, path) {
  const up = http.request({ host: "127.0.0.1", port, method: req.method, path, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("proxy error"); });
  req.pipe(up);
}
function unified() {
  return new Promise((resolve) => {
    http.createServer(async (req, res) => {
      const path = req.url;
      if (path.startsWith("/coord/")) return proxy(req, res, COORD, path.slice(6));   // strip "/coord"
      if (path.startsWith("/faucet/")) return proxy(req, res, FAUCET, path.slice(7)); // strip "/faucet"
      try {
        const rel = decodeURIComponent(path.split("?")[0]);
        const file = join(ROOT, rel === "/" ? "/index.html" : rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        let body = await readFile(file);
        if (file.endsWith("index.html")) body = Buffer.from(body.toString().replace("</head>", `${CONFIG}\n</head>`));
        res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" }); res.end(body);
      } catch { res.writeHead(404); res.end("not found"); }
    }).listen(WEB, "0.0.0.0", () => resolve());
  });
}
async function loadWallets() {
  for (const w of ["alice", "bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  for (const w of ["alice", "bob"]) for (let i = 0; i < 40; i++) { const wi = await qbit.rpcWallet(w, "getwalletinfo"); if (!wi.pqc_key_validation?.signing_blocked) break; await sleep(2000); }
}
const qmineTo = async (n) => qbit.rpcWallet("bob", "generatetoaddress", n, await qbit.rpcWallet("bob", "getnewaddress"));
const bmine = async (n) => btc.rpcWallet("alice", "generatetoaddress", n, await btc.rpcWallet("alice", "getnewaddress"));

async function main() {
  await startServer(COORD);
  await startFaucet(FAUCET);
  await unified();
  if (process.env.ADMIN !== "off") await startAdmin(Number(process.env.ADMIN_PORT || 8790));
  await loadWallets();
  if (Number(await qbit.rpcWallet("bob", "getbalance")) < 50) await qmineTo(1010);
  if (Number(await btc.rpcWallet("alice", "getbalance")) < 10) await bmine(101);
  (async () => { for (;;) { try { await bmine(1); await qmineTo(1); } catch {} await sleep(7000); } })();

  console.log(`\n  qbit-swap TRIAL is live`);
  console.log(`  ┌──────────────────────────────────────────────────────────────`);
  console.log(`  │  Public URL:  ${PUBLIC_URL}   (serve local port ${WEB} over HTTPS)`);
  console.log(`  │  same-origin: ${PUBLIC_URL}/coord  +  ${PUBLIC_URL}/faucet`);
  console.log(`  │  Chains:      BTC regtest + QBT regtest (throwaway) · mining every 7s`);
  console.log(`  └──────────────────────────────────────────────────────────────\n`);
}
main().catch((e) => { console.error("TRIAL failed:", e.message); process.exit(1); });
