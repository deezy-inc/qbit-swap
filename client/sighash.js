// P2MR (BIP-341/taproot-style) script-path signature hash. Ports reference/sighash.py.
// Verified against qbit-core: tag "P2MRSighash", SigVersion::P2MR (ext_flag=1, key_version=0).
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, u8, leU, compactSize } from "./encoding.js";
import { taggedHash, singleLeafRoot } from "./p2mr.js";

export const SIGHASH_DEFAULT = 0x00;

// vin: [{txidLE: Uint8Array(32), vout: int, sequence: int}]  (txid in wire/internal order)
// spentOutputs: [{amount: bigint|number, spk: Uint8Array}] aligned to vin
// vout: [{value: bigint|number, spk: Uint8Array}]
export function p2mrSighash({ version, locktime, vin, spentOutputs, vout, inputIndex, leafScript, hashType = SIGHASH_DEFAULT }) {
  if (hashType !== SIGHASH_DEFAULT) throw new Error("only SIGHASH_DEFAULT implemented");
  const shaPrevouts = sha256(concatBytes(...vin.map((i) => concatBytes(i.txidLE, leU(i.vout, 4)))));
  const shaAmounts = sha256(concatBytes(...spentOutputs.map((o) => leU(o.amount, 8))));
  const shaSpks = sha256(concatBytes(...spentOutputs.map((o) => concatBytes(compactSize(o.spk.length), o.spk))));
  const shaSequences = sha256(concatBytes(...vin.map((i) => leU(i.sequence, 4))));
  const shaOutputs = sha256(concatBytes(...vout.map((o) => concatBytes(leU(o.value, 8), compactSize(o.spk.length), o.spk))));
  const tapleafHash = singleLeafRoot(leafScript);

  const msg = concatBytes(
    u8(0x00),                     // epoch
    u8(hashType),                 // hash type
    leU(version, 4), leU(locktime, 4),
    shaPrevouts, shaAmounts, shaSpks, shaSequences,
    shaOutputs,                   // SIGHASH_ALL (default)
    u8(0x02),                     // spend_type = ext_flag(1)<<1 + annex(0)
    leU(inputIndex, 4),
    tapleafHash, u8(0x00), leU(0xffffffff, 4)); // tapleaf hash, key_version, codeseparator_pos
  return taggedHash("P2MRSighash", msg);
}
