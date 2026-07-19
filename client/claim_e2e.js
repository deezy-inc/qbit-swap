// End-to-end, fully in JS: build a p2mr HTLC claim, sign it with the WASM SLH-DSA signer, and get it
// accepted by the regtest node (built from `main`). Node RPC goes over ssh here; in the browser this
// same logic talks to the coordinator instead. Proves the in-browser signing pipeline node-to-node.
import { execFileSync } from "node:child_process";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { htlcLeafQbit, p2mrSpk, p2mrAddress, P2MR_CONTROL_SINGLE_LEAF } from "./p2mr.js";
import { p2mrSighash } from "./sighash.js";
import { serializeTx } from "./tx.js";
import { slhDsaSign } from "./signer.js";

const HOST = process.env.LAB_SSH_HOST || "localhost";   // regtest lab over ssh; set for a remote host
const NODE = "docker exec qbitbuild /src/build/bin/qbit-cli -regtest -datadir=/root/qbrtp -rpcuser=lab -rpcpassword=lab -rpcwallet=bob";
const q = (...a) => {
  const args = a.map((x) => (x === true ? "true" : x === false ? "false" : String(x)));
  const remote = NODE + " " + args.map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(" ");
  const out = execFileSync("ssh", ["-o", "ConnectTimeout=15", HOST, remote], { encoding: "utf8" }).trim();
  try { return JSON.parse(out); } catch { return out; }
};

// controlled vanity keypair (seed 0x11): we hold the SLH-DSA secret key
const RECV_PUB = bin("d6c2b3977708d7de974059b650874bc1555ff3194962627737f97dbaefe3dd39");
const RECV_SK = bin("21d53e8c37f8b27e965881c331e20f75019cacd578a91f593309ecdb2c6b9a3bd6c2b3977708d7de974059b650874bc1555ff3194962627737f97dbaefe3dd39");
const FUND_PUB = bin("7d6b1ab4e067e6b1aff97ea1c4fcf58cd01d841130a1c78d5a0c242f58f08bf1");
const preimage = new Uint8Array(32).fill(0x11);
const H = sha256(preimage);

(async () => {
  const leaf = htlcLeafQbit(H, RECV_PUB, FUND_PUB, 200);
  const spk = p2mrSpk(leaf), addr = p2mrAddress(leaf, "qbrt");
  console.log("[i] HTLC", addr);
  const txid = q("sendtoaddress", addr, 5); q("generatetoaddress", 1, q("getnewaddress"));
  const o = q("getrawtransaction", txid, true).vout.find((o) => o.scriptPubKey.hex === hex(spk));
  const n = o.n, sats = Math.round(o.value * 1e8);
  console.log(`[i] funded ${txid.slice(0,16)}..:${n} = ${sats/1e8} QBT`);

  const dest = q("getnewaddress"); const destSpk = bin(q("getaddressinfo", dest).scriptPubKey);
  const prevoutLE = bin(txid).reverse(); const outVal = sats - 100000;
  const sh = p2mrSighash({ version: 2, locktime: 0,
    vin: [{ txidLE: prevoutLE, vout: n, sequence: 0xffffffff }],
    spentOutputs: [{ amount: sats, spk }], vout: [{ value: outVal, spk: destSpk }],
    inputIndex: 0, leafScript: leaf });
  console.log("[i] P2MR sighash =", hex(sh));
  const sig = await slhDsaSign(RECV_SK, sh);
  console.log(`[i] SLH-DSA signature from WASM signer: ${sig.length} bytes`);

  const tx = serializeTx({ version: 2, vin: [[prevoutLE, n, new Uint8Array(0), 0xffffffff]],
    vout: [[BigInt(outVal), destSpk]], wit: [[sig, preimage, Uint8Array.of(0x01), leaf, P2MR_CONTROL_SINGLE_LEAF]], locktime: 0 });
  const acc = q("testmempoolaccept", JSON.stringify([hex(tx)]))[0];
  console.log(`[>] node testmempoolaccept: allowed=${acc.allowed} ${acc["reject-reason"] || ""}`);
  if (acc.allowed) {
    const ctxid = q("sendrawtransaction", hex(tx)); q("generatetoaddress", 1, q("getnewaddress"));
    const wit = q("getrawtransaction", ctxid, true).vin[0].txinwitness;
    const revealed = wit.find((x) => x.length === 64 && hex(sha256(bin(x))) === hex(H));
    console.log(`[>] JS+WASM-signed claim ACCEPTED by node: ${ctxid}`);
    console.log(`[>] preimage revealed on-chain: ${revealed} (== ours: ${revealed === hex(preimage)})`);
    console.log("\n=== PASS — a fully in-JS (WASM-signed) p2mr HTLC claim was accepted by the node ===");
  } else console.log("=== FAIL ===");
})();
