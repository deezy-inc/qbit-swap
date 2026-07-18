// Keyless chain adapter for the coordinator: watch (funding), confirmations, spent-detection,
// broadcast — no wallet, no keys. Each chain picks a backend independently via env:
//
//   <CHAIN>_BACKEND = "dev" | "rpc" | "esplora"   (falls back to COORD_CHAIN, then "dev")
//
//   dev      — shells to a node CLI (optionally over ssh). Set <CHAIN>_CLI and, to run remotely,
//              <CHAIN>_SSH_HOST. This is the local-lab transport; no hostnames are baked in.
//   rpc      — direct JSON-RPC over HTTP. Set <CHAIN>_RPC_URL (e.g. http://user:pass@host:port).
//   esplora  — mempool.space / Esplora REST API (BTC leg only; no own Bitcoin node needed). Set
//              ESPLORA_URL (default https://mempool.space/api). Includes rate-limit handling.
//
// Qbit has no public backend, so the QBT leg must use "dev" or "rpc" against your own qbitd — and the
// reorg-safe confirmation gate (getconfirmationtarget) is a qbitd RPC.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
const pexec = promisify(execFile);

const env = (k, d) => process.env[k] ?? d;
const backendOf = (name) => env(`${name.toUpperCase()}_BACKEND`, env("COORD_CHAIN", "dev"));
const cliOf = (name) => env(`${name.toUpperCase()}_CLI`, `${name === "btc" ? "bitcoin-cli" : "qbit-cli"} -regtest -rpcuser=lab -rpcpassword=lab`);
const sshOf = (name) => env(`${name.toUpperCase()}_SSH_HOST`, "");      // empty = run the CLI locally
const rpcUrlOf = (name) => env(`${name.toUpperCase()}_RPC_URL`, "");

// ── Esplora REST client with rate-limit handling (shared min-interval + 429/5xx backoff) ──────
const ESPLORA_URL = env("ESPLORA_URL", "https://mempool.space/api").replace(/\/$/, "");
const ESPLORA_MIN_INTERVAL_MS = Number(env("ESPLORA_MIN_INTERVAL_MS", 150));   // ~6.6 req/s ceiling
const ESPLORA_MAX_RETRIES = Number(env("ESPLORA_MAX_RETRIES", 6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gate = Promise.resolve();                                                   // serializes + spaces requests
function throttle() { const p = gate.then(() => sleep(ESPLORA_MIN_INTERVAL_MS)); gate = p.catch(() => {}); return p; }
const backoffMs = (attempt, retryAfterSec) => (retryAfterSec ? retryAfterSec * 1000 : Math.min(10000, 300 * 2 ** attempt));
async function esplora(path, opts = {}, attempt = 0) {
  await throttle();
  let res;
  try { res = await fetch(ESPLORA_URL + path, opts); }
  catch (e) { if (attempt < ESPLORA_MAX_RETRIES) { await sleep(backoffMs(attempt)); return esplora(path, opts, attempt + 1); } throw e; }
  if (res.status === 429 || res.status >= 500) {                                // rate limited / transient
    if (attempt < ESPLORA_MAX_RETRIES) { await sleep(backoffMs(attempt, Number(res.headers.get("retry-after")) || 0)); return esplora(path, opts, attempt + 1); }
    throw new Error(`esplora ${res.status} on ${path}`);
  }
  return res;
}
const scripthash = (spkHex) => bytesToHex(sha256(hexToBytes(spkHex)).reverse());   // Esplora address index key

export class Chain {
  constructor(name) { this.name = name; this.backend = backendOf(name); }

  // ── dev/rpc transport ────────────────────────────────────────────────────────
  async rpc(...args) { return this.backend === "rpc" ? this.#jsonRpc(this.#coerce(args)) : this.#cli(this.#coerce(args)); }
  async rpcWallet(wallet, ...args) { return this.backend === "rpc" ? this.#jsonRpc(this.#coerce(args), wallet) : this.#cli(this.#coerce(args), `-rpcwallet=${wallet}`); }
  #coerce(args) { return args.map((x) => (x === true ? "true" : x === false ? "false" : String(x))); }
  async #cli(a, extra = "") {
    const cmd = `${cliOf(this.name)} ${extra} ` + a.map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(" ");
    const host = sshOf(this.name);
    const { stdout } = host
      ? await pexec("ssh", ["-o", "ConnectTimeout=15", host, cmd], { maxBuffer: 64 << 20 })
      : await pexec("sh", ["-c", cmd], { maxBuffer: 64 << 20 });
    const s = stdout.trim(); try { return JSON.parse(s); } catch { return s; }
  }
  async #jsonRpc(a, wallet) {
    const [method, ...rest] = a;
    const params = rest.map((p) => { try { return JSON.parse(p); } catch { return p; } });
    const u = new URL(rpcUrlOf(this.name));
    const auth = u.username ? "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64") : undefined;
    const r = await fetch(`${u.protocol}//${u.host}${wallet ? `/wallet/${wallet}` : "/"}`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "1.0", id: "coord", method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }

  // ── reads (dispatch to esplora when configured) ──────────────────────────────
  async height() {
    if (this.backend === "esplora") return Number(await (await esplora("/blocks/tip/height")).text());
    return Number(await this.rpc("getblockcount"));
  }
  // Locate a confirmed UTXO paying `spkHex`. Returns null until seen. Funding-watch method by backend:
  //   esplora — indexed scripthash lookup (O(1), no scan)
  //   rpc     — a forward-only watch-only wallet (import once with timestamp "now", then listunspent);
  //             this is the mainnet-safe path — NEVER scantxoutset, which rescans the whole UTXO set
  //   dev     — scantxoutset, fine only because regtest's UTXO set is tiny
  async findOutput(spkHex) {
    if (this.backend === "esplora") {
      const utxos = await (await esplora(`/scripthash/${scripthash(spkHex)}/utxo`)).json();
      const u = (utxos || []).find((x) => x.status?.confirmed);
      return u ? { txid: u.txid, vout: u.vout, amountSats: u.value, height: u.status.block_height } : null;
    }
    if (this.backend === "rpc") {
      const wallet = await this.#ensureWatched(spkHex);
      const utxos = await this.rpcWallet(wallet, "listunspent", 0, 9999999, "[]", true);
      const u = (utxos || []).find((x) => x.scriptPubKey === spkHex && x.confirmations > 0);
      return u ? { txid: u.txid, vout: u.vout, amountSats: Math.round(u.amount * 1e8), height: (await this.height()) - u.confirmations + 1 } : null;
    }
    const scan = await this.rpc("scantxoutset", "start", JSON.stringify([`raw(${spkHex})`]));
    const u = (scan.unspents || [])[0];
    return u ? { txid: u.txid, vout: u.vout, amountSats: Math.round(u.amount * 1e8), height: u.height } : null;
  }
  // Import an HTLC scriptPubKey into a dedicated watch-only wallet, forward-only (no historical rescan
  // — HTLC addresses are fresh). Idempotent per process; safe to call every poll.
  async #ensureWatched(spkHex) {
    if (!this._watched) { this._watchWallet = env("WATCH_WALLET", "qbitswap-watch"); this._watched = new Set(); await this.#openWallet(this._watchWallet); }
    if (this._watched.has(spkHex)) return this._watchWallet;
    await this.#importSpk(this._watchWallet, spkHex);
    this._watched.add(spkHex);
    return this._watchWallet;
  }
  async #openWallet(name) {
    try { await this.rpc("createwallet", name, true, true, "", false, true); } catch { /* exists */ }   // watch-only descriptor wallet
    try { await this.rpc("loadwallet", name); } catch { /* already loaded */ }
  }
  async #importSpk(wallet, spkHex) {
    const info = await this.rpcWallet(wallet, "getdescriptorinfo", `raw(${spkHex})`);
    await this.rpcWallet(wallet, "importdescriptors", JSON.stringify([{ desc: info.descriptor, timestamp: "now" }]));
  }
  // Purge settled swaps' descriptors so the watch-only wallet doesn't balloon over time. Bitcoin Core
  // has no removedescriptors, so we rotate to a fresh wallet generation holding only `keepSpks` (the
  // still-active swaps), import into it before unloading the old one (no coverage gap), then drop the
  // old wallet. Safe on a pruned node: kept addresses re-import forward-only, and a funded leg no
  // longer needs the wallet (spent-detection is gettxout on the UTXO set; its outpoint is recorded).
  async pruneWatch(keepSpks, threshold = Number(env("WATCH_PRUNE_THRESHOLD", 500))) {
    if (this.backend !== "rpc" || !this._watched) return;
    const keep = new Set(keepSpks);
    // Count-driven, not time-driven: let settled descriptors amortize, then rotate once. A wallet with
    // a few hundred stale descriptors is harmless, so there's no rush — this is unrelated to block time.
    const droppable = [...this._watched].filter((s) => !keep.has(s)).length;
    if (droppable < Math.max(1, threshold)) return;
    const gen = (this._gen || 0) + 1;
    const next = `${env("WATCH_WALLET", "qbitswap-watch")}-g${gen}`;
    await this.#openWallet(next);
    for (const spk of keep) { try { await this.#importSpk(next, spk); } catch { /* skip */ } }
    const prev = this._watchWallet;
    this._watchWallet = next; this._watched = new Set(keep); this._gen = gen;
    if (prev && prev !== next) { try { await this.rpc("unloadwallet", prev); } catch { /* already gone */ } }
    return { wallet: next, kept: keep.size };
  }
  async confs(fundingHeight) { return (await this.height()) - fundingHeight + 1; }
  async isUnspent(txid, vout) {
    if (this.backend === "esplora") { const o = await (await esplora(`/tx/${txid}/outspend/${vout}`)).json(); return !o.spent; }
    const o = await this.rpc("gettxout", txid, vout, true); return o != null && o !== "null" && o !== "";
  }
  async testAccept(txHex) {
    if (this.backend === "esplora") return { allowed: true };   // Esplora has no testmempoolaccept; broadcast surfaces errors
    const r = (await this.rpc("testmempoolaccept", JSON.stringify([txHex])))[0]; return { allowed: r.allowed, reason: r["reject-reason"] };
  }
  async broadcast(txHex) {
    if (this.backend === "esplora") { const res = await esplora("/tx", { method: "POST", headers: { "content-type": "text/plain" }, body: txHex }); if (!res.ok) throw new Error(`broadcast rejected: ${await res.text()}`); return (await res.text()).trim(); }
    return this.rpc("sendrawtransaction", txHex);
  }
  async getTx(txid) {
    if (this.backend === "esplora") { const tx = await (await esplora(`/tx/${txid}`)).json(); return { vin: (tx.vin || []).map((i) => ({ txinwitness: i.witness || [] })), vout: tx.vout, status: tx.status }; }
    if (this.backend === "rpc") {
      // Pruned-safe: read via the watch-only wallet — gettransaction returns wallet-relevant txs
      // (the claim spends an address we watch) without needing txindex. Fall back to getrawtransaction.
      try { const g = await this.rpcWallet(this._watchWallet || env("WATCH_WALLET", "qbitswap-watch"), "gettransaction", txid, true, true); if (g?.decoded) return g.decoded; } catch { /* not a wallet tx */ }
    }
    return this.rpc("getrawtransaction", txid, true);
  }

  // Qbit only: reorg-safe confirmation target for a trade value + security level.
  async confTarget(valueSats, level = "high") {
    const r = await this.rpc("getconfirmationtarget", valueSats, level);
    return { confs: r.required_confirmations, minutes: r.required_minutes, equivalentBtcConfs: r.equivalent_btc_confirmations, level: r.security_level };
  }
  // dev helpers (regtest only)
  async mine(n, addr) { return this.rpc("generatetoaddress", n, addr); }
  async newAddress(wallet) { return this.rpcWallet(wallet, "getnewaddress"); }
}

export const qbit = new Chain("qbit");
export const btc = new Chain("btc");
