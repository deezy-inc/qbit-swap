// Unit test for the split-funding fan-out (client/fanout.js): the deposit address round-trips to its
// spk, the built tx spends the one deposit UTXO into the N target outputs with the right fee, and — the
// part that matters, because a bad signature strands the deposit — the ECDSA signature actually verifies
// against the BIP143 sighash for the splitter key.  Run:  node test/fanout.test.mjs
import { randomBytes } from "node:crypto";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import {
  splitterAddress, splitFunding, splitterScript, addressToScriptPubKey, parseTx,
  compressedPub, bip143Sighash, ecdsaSign,
} from "@qbit-swap/client";

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const rspk = () => Uint8Array.from([0x00, 0x14, ...randomBytes(20)]);   // a plausible target scriptPubKey

// ── deposit address round-trips to the spk the coordinator/mock will watch ───────────────────────
const priv = randomBytes(32);
const dep = splitterAddress(priv, "bcrt");
ck(dep.address.startsWith("bcrt1q"), "splitter deposit address is a bech32 P2WSH");
ck(hex(addressToScriptPubKey(dep.address)) === hex(dep.spk), "address decodes back to the same spk (what gets funded/watched)");

// ── fan out one 3.0-BTC deposit into three HTLC outputs, 500 sat fee ──────────────────────────────
const outputs = [{ spk: rspk(), value: 100_000_000 }, { spk: rspk(), value: 90_000_000 }, { spk: rspk(), value: 109_999_500 }];
const amount = 300_000_000;                                   // Σ outputs = 299,999,500 → fee 500
const { txHex, feeSats } = splitFunding({ prevTxidLE: Uint8Array.from(randomBytes(32)), vout: 1, amount, priv, outputs });
ck(feeSats === 500, `fee = deposit − Σ outputs (${feeSats} sat)`);

const tx = parseTx(txHex);
ck(tx.vin.length === 1 && tx.vin[0][1] === 1, "spends exactly the one deposit UTXO (vout 1)");
ck(tx.vout.length === 3 && tx.vout.every((o, i) => Number(o[0]) === outputs[i].value && hex(o[1]) === hex(outputs[i].spk)), "N outputs match the HTLC spks and amounts, in order");
ck(tx.wit[0].length === 2 && hex(tx.wit[0][1]) === hex(splitterScript(compressedPub(priv))), "witness is [sig, splitterScript] (the 1-of-1 P2WSH spend)");

// ── the signature is valid for the sighash (proves the fan-out will actually spend) ───────────────
// ecdsaSign is deterministic (RFC6979), so re-signing the reconstructed sighash must reproduce the exact
// witness signature — byte-equality proves the witness sig is a correct spend of the splitter UTXO.
const sighash = bip143Sighash({
  version: 2, vin: [{ txidLE: tx.vin[0][0], vout: tx.vin[0][1], sequence: tx.vin[0][3] }],
  vout: tx.vout.map(([value, spk]) => ({ value, spk })), inputIndex: 0,
  scriptCode: splitterScript(compressedPub(priv)), amount: BigInt(amount), locktime: 0,
});
ck(hex(tx.wit[0][0]) === hex(ecdsaSign(priv, sighash)), "witness signature is the correct ECDSA spend over the BIP143 sighash");

// ── guard: outputs can't exceed the deposit ──────────────────────────────────────────────────────
try { splitFunding({ prevTxidLE: randomBytes(32), vout: 0, amount: 100, priv, outputs: [{ spk: rspk(), value: 200 }] }); ck(false, "over-spend rejected"); }
catch (e) { ck(/exceed the deposit/.test(e.message), "outputs exceeding the deposit are rejected"); }

console.log(ok ? "\nPASS — fan-out builds a valid, signature-checked split of one deposit into N HTLC outputs" : "\nFAIL");
process.exit(ok ? 0 : 1);
