import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { singleLeafRoot, singleKeyLeaf, p2mrAddress, htlcLeafQbit } from "./p2mr.js";
import { p2mrSighash } from "./sighash.js";
import { parseTx } from "./tx.js";

let pass = true;
const ck = (name, ok, extra="") => { console.log(`[${ok?"ok":"FAIL"}] ${name}${extra?" — "+extra:""}`); pass = pass && ok; };

// 1) single-key leaf root vs the live-node golden (pubkey d6d86f51.. -> root 36836a9b..)
const PUB = bin("d6d86f51b6de632fb0a9336acb3710c8c9f372577318af58881d28e0bc585f83");
ck("p2mr leaf root matches node golden", hex(singleLeafRoot(singleKeyLeaf(PUB))) === "36836a9b1f798efe3c80fd6f2c020e568c338e66325f43e8fc876a5e00f86b9d");
// 2) bech32m address matches the node's address for that key
ck("bech32m address matches node", p2mrAddress(singleKeyLeaf(PUB), "qbrt") === "qbrt1zx6pk4xcl0x80u0yql4hjcqsw26xr8rnxxf05868usa49uq8cdwws9a930l");

// 3) P2MR sighash vs golden witness vector (single_key_default_sighash)
const v = JSON.parse(readFileSync(new URL("../reference/vectors.json", import.meta.url)))[0];
const t = parseTx(v.spendTx);
const sh = p2mrSighash({
  version: t.version, locktime: t.locktime,
  vin: t.vin.map(([txidLE, vout, , seq]) => ({ txidLE, vout, sequence: seq })),
  spentOutputs: v.spentOutputs.map((o) => ({ amount: o.amount, spk: bin(o.scriptPubKey) })),
  vout: t.vout.map(([value, spk]) => ({ value, spk })),
  inputIndex: v.inputIndex, leafScript: bin(v.leafScript),
});
ck("P2MR sighash matches golden vector", hex(sh) === v.p2mrSighash, hex(sh).slice(0,16)+"..");

// 4) HTLC leaf byte-identical to the python lib's output (spot check length/prefix)
const H = sha256(new Uint8Array(32).fill(0x11));
const leaf = htlcLeafQbit(H, PUB, PUB, 200);
ck("HTLC leaf builds", leaf[0] === 0x63 && leaf[leaf.length-1] === 0x68, `len=${leaf.length}`);

console.log("\n" + (pass ? "ALL PASS — JS p2mr/sighash/tx port matches the chain" : "FAILURES ABOVE"));
process.exit(pass ? 0 : 1);
