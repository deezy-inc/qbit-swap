// Validate the JS Bitcoin leg against regtest bitcoind: fund a P2WSH HTLC -> claim, and -> refund.
import { execFileSync } from "node:child_process";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { htlcWitnessScript, p2wshSpk, p2wshAddr, compressedPub, btcSpend } from "./bitcoin.js";

const HOST = process.env.LAB_SSH_HOST || "localhost";   // regtest lab over ssh; set for a remote host
const BASE = "docker exec btcregtest bitcoin-cli -regtest -rpcuser=lab -rpcpassword=lab -rpcwallet=alice";
const b = (...a) => {
  const args = a.map((x) => (x === true ? "true" : x === false ? "false" : String(x)));
  const remote = BASE + " " + args.map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(" ");
  const out = execFileSync("ssh", ["-o", "ConnectTimeout=15", HOST, remote], { encoding: "utf8" }).trim();
  try { return JSON.parse(out); } catch { return out; }
};
const spkOf = (addr) => bin(b("getaddressinfo", addr).scriptPubKey);
const vout = (txid, spkHex) => { const o = b("getrawtransaction", txid, true).vout.find((o) => o.scriptPubKey.hex === spkHex); return [o.n, Math.round(o.value * 1e8)]; };
const height = () => b("getblockcount");
const mine = (n) => b("generatetoaddress", n, b("getnewaddress"));

try { execFileSync("ssh", [HOST, "docker exec btcregtest bitcoin-cli -regtest -rpcuser=lab -rpcpassword=lab loadwallet alice"], { stdio: "ignore" }); } catch {}
const claimPriv = bin("0000000000000000000000000000000000000000000000000000000000000b0b");
const refundPriv = bin("00000000000000000000000000000000000000000000000000000000000a11ce");
const claimPub = compressedPub(claimPriv), refundPub = compressedPub(refundPriv);
const preimage = new Uint8Array(32).fill(0x11), H = sha256(preimage);
let pass = true; const ck = (n, ok, x = "") => { console.log(`[${ok ? "ok" : "FAIL"}] ${n}${x ? " — " + x : ""}`); pass = pass && ok; };

// CLAIM
let ws = htlcWitnessScript(H, claimPub, refundPub, 200), addr = p2wshAddr(ws);
let txid = b("sendtoaddress", addr, 1); mine(1);
let [n, amt] = vout(txid, hex(p2wshSpk(ws)));
let dest = spkOf(b("getnewaddress"));
let tx = btcSpend({ prevTxidLE: bin(txid).reverse(), vout: n, amount: amt, ws, priv: claimPriv, destSpk: dest, outVal: amt - 5000, branch: "claim", preimage });
ck("BTC claim accepted", b("testmempoolaccept", JSON.stringify([hex(tx)]))[0].allowed);
b("sendrawtransaction", hex(tx)); mine(1);

// REFUND (rejected before timeout, accepted after)
const lt = height() + 5;
ws = htlcWitnessScript(H, claimPub, refundPub, lt); addr = p2wshAddr(ws);
txid = b("sendtoaddress", addr, 1); mine(1); [n, amt] = vout(txid, hex(p2wshSpk(ws)));
dest = spkOf(b("getnewaddress"));
const refund = btcSpend({ prevTxidLE: bin(txid).reverse(), vout: n, amount: amt, ws, priv: refundPriv, destSpk: dest, outVal: amt - 5000, branch: "refund", locktime: lt });
ck(`BTC refund rejected before timeout (h=${height()}<${lt})`, b("testmempoolaccept", JSON.stringify([hex(refund)]))[0].allowed === false);
mine(lt - height() + 1);
ck(`BTC refund accepted after timeout (h=${height()}>=${lt})`, b("testmempoolaccept", JSON.stringify([hex(refund)]))[0].allowed);

console.log("\n" + (pass ? "ALL PASS — JS Bitcoin P2WSH HTLC leg validated against bitcoind" : "FAILURES ABOVE"));
process.exit(pass ? 0 : 1);
