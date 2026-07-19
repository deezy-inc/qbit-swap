// TRIAL-ONLY faucet for the hosted demo. Lets a browser-only user fund an HTLC and get throwaway
// receiving addresses on the regtest nodes, so they can click through a full swap without owning
// coins. NOT part of the product: it holds wallet keys (the coordinator never does) and only touches
// throwaway regtest wallets. Never point this at testnet/mainnet.
import http from "node:http";
import { qbit, btc } from "../../coordinator/chain.js";

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });

// funding sources (pre-funded) and a distinct wallet to hand out receiving addresses from
const FUND = { btc: { chain: btc, wallet: "alice" }, qbit: { chain: qbit, wallet: "bob" } };
const RECV = { btc: { chain: btc, wallet: "bob", type: "bech32" }, qbit: { chain: qbit, wallet: "alice", type: null } };

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (req.method === "GET" && url.pathname === "/newaddress") {
      const r = RECV[url.searchParams.get("leg")]; if (!r) return json(res, 400, { error: "bad leg" });
      const addr = r.type ? await r.chain.rpcWallet(r.wallet, "getnewaddress", "", r.type) : await r.chain.rpcWallet(r.wallet, "getnewaddress");
      return json(res, 200, { address: addr });
    }
    if (req.method === "POST" && url.pathname === "/fund") {
      const { leg, address, sats } = await readBody(req);
      const f = FUND[leg]; if (!f) return json(res, 400, { error: "bad leg" });
      if (!address || !(sats > 0)) return json(res, 400, { error: "address and sats required" });
      const amount = (sats / 1e8).toFixed(8);
      const txid = await f.chain.rpcWallet(f.wallet, "sendtoaddress", address, amount);
      return json(res, 200, { txid });   // the background miner will confirm it
    }
    return json(res, 404, { error: "not found" });
  } catch (e) { return json(res, 400, { error: String(e.message || e).split("\n")[0] }); }
}

export function startFaucet(port = 8788) {
  return new Promise((resolve) => http.createServer(handle).listen(port, "0.0.0.0", () => resolve(port)));
}
if (import.meta.url === `file://${process.argv[1]}`) startFaucet(Number(process.env.FAUCET_PORT) || 8788).then((p) => console.log("faucet on", p));
