// Split-funding "fan-out" for multi-maker fills. When one retail order is routed across N makers, the
// user shouldn't have to make N deposits (and can't, sending from an exchange that allows one
// destination). Instead the browser makes ONE ephemeral key, shows its address as the single deposit
// target, and — the instant the user's deposit shows up (mempool is fine) — spends it into the N HTLC
// scriptPubKeys in a single transaction. Same-or-higher feerate than the parent means the two confirm
// together, so the extra hop adds no real latency or risk. The ephemeral key is a plain 1-of-1 P2WSH
// (`<pub> OP_CHECKSIG`) so this needs no primitive the HTLC path doesn't already have; if the fan-out is
// ever interrupted before broadcast, the deposit is recoverable from that key (it's in the backup).
import { sha256 } from "@noble/hashes/sha2.js";
import { compressedPub, ecdsaSign, bip143Sighash, serializeSegwit, p2wshSpk, p2wshAddr } from "./bitcoin.js";
import { concatBytes, u8, pushData } from "./encoding.js";

const OP_CHECKSIG = 0xac;
// The ephemeral holding script for the splitter key: <33-byte compressed pub> OP_CHECKSIG.
export const splitterScript = (pub) => concatBytes(pushData(pub), u8(OP_CHECKSIG));
// The deposit address + spk the user sends their single deposit to (P2WSH of the splitter script).
export function splitterAddress(priv, hrp = "bcrt") {
  const script = splitterScript(compressedPub(priv));
  return { address: p2wshAddr(script, hrp), spk: p2wshSpk(script), script };
}

// Build the signed fan-out tx: spend the single funded splitter UTXO into `outputs` (each { spk, value }
// — the HTLC scriptPubKeys and the sats each leg needs). The fee is whatever's left (amount − Σvalue),
// so the caller sizes the deposit as Σ(leg needs) + the fan-out fee it wants to pay.
export function splitFunding({ prevTxidLE, vout, amount, priv, outputs }) {
  if (!outputs?.length) throw new Error("splitFunding needs at least one output");
  const script = splitterScript(compressedPub(priv));
  const vin = [{ txidLE: prevTxidLE, vout, sequence: 0xffffffff }];
  const outs = outputs.map((o) => ({ value: BigInt(o.value), spk: o.spk }));
  const spend = outs.reduce((n, o) => n + o.value, 0n);
  if (spend > BigInt(amount)) throw new Error(`fan-out outputs (${spend}) exceed the deposit (${amount})`);
  const sig = ecdsaSign(priv, bip143Sighash({ version: 2, vin, vout: outs, inputIndex: 0, scriptCode: script, amount: BigInt(amount), locktime: 0 }));
  return { txHex: hex(serializeSegwit(2, vin, outs, [[sig, script]], 0)), feeSats: Number(BigInt(amount) - spend) };
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
