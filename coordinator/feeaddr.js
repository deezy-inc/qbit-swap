// Watch-only coordinator-fee address derivation. The admin creates the fee wallet themselves and hands
// the coordinator a taproot xpub (or a tr(...) output descriptor) plus a chain/branch. From that public
// key alone the coordinator derives a FRESH P2TR receive address per swap — BIP32 non-hardened children
// of the xpub, then the BIP86 taproot tweak — incrementing an index it persists. It never sees a private
// key, so it can watch fees arrive but can NEVER spend them. No node wallet, no funds on the coordinator.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin, concatBytes } from "@noble/hashes/utils.js";
import { Point } from "@noble/secp256k1";
import { segwitAddr } from "../client/p2mr.js";   // bech32m witness-program encoder (BIP-350)

const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Bitcoin bech32 hrp per network — the fee address must be spendable on the same chain as the swap's BTC.
export const BTC_HRP = { mainnet: "bc", testnet: "tb", signet: "tb", regtest: "bcrt" };

const toNum = (b) => (b.length ? BigInt("0x" + hex(b)) : 0n);
const ser32 = (i) => Uint8Array.of((i >>> 24) & 0xff, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff);
const be32 = (n) => bin(n.toString(16).padStart(64, "0"));   // 32-byte big-endian of a bigint

function b58checkDecode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58 character"); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.unshift(0);   // leading-zero bytes
  const arr = Uint8Array.from(bytes), body = arr.slice(0, -4), chk = arr.slice(-4);
  const h = sha256(sha256(body));
  for (let i = 0; i < 4; i++) if (h[i] !== chk[i]) throw new Error("bad base58check checksum");
  return body;
}

// Decode an extended PUBLIC key → { pub (33-byte compressed), cc (32-byte chain code) }.
function parseXpub(xpub) {
  const d = b58checkDecode(xpub.trim());
  if (d.length !== 78) throw new Error(`bad extended key length ${d.length}`);
  const cc = d.slice(13, 45), key = d.slice(45, 78);   // [ver4][depth1][fp4][childno4][cc32][key33]
  if (key.length !== 33 || !(key[0] === 2 || key[0] === 3)) throw new Error("not a public xpub (an xprv/private key is never accepted)");
  return { pub: key, cc };
}

// BIP32 CKDpub: non-hardened public child derivation. Hardened indices are impossible from an xpub (by
// design — that's what keeps this watch-only), so we reject them.
function ckdPub(pub, cc, i) {
  if (i < 0 || i >= 0x80000000) throw new Error(`index ${i} must be a non-hardened child (0 .. 2^31-1)`);
  const I = hmac(sha512, cc, concatBytes(pub, ser32(i)));
  const ilNum = toNum(I.slice(0, 32));
  if (ilNum === 0n || ilNum >= SECP_N) throw new Error("degenerate child key — pick the next index");
  const child = Point.BASE.multiply(ilNum).add(Point.fromHex(hex(pub)));
  return { pub: child.toBytes(true), cc: I.slice(32) };
}

const taggedHash = (tag, msg) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(concatBytes(t, t, msg)); };

// BIP86 P2TR address from a derived (BIP32) public key: tweak the x-only internal key by
// t = tagged_hash("TapTweak", x) and take the x-coordinate of Q = lift_x(x) + t·G.
function p2trAddress(pub, hrp) {
  const x = pub.slice(1, 33);
  const internal = Point.fromHex("02" + hex(x));            // lift_x → even-y internal key
  const tnum = toNum(taggedHash("TapTweak", x));
  if (tnum >= SECP_N) throw new Error("invalid taproot tweak");
  const Q = internal.add(Point.BASE.multiply(tnum));
  return segwitAddr(hrp, 1, be32(Q.x));                     // witness v1, bech32m
}

// Accept either a bare xpub or a `tr([origin]xpub/<branch>/*)` descriptor. Returns { xpub, branch }.
// The branch is the chain index just before the `/*` wildcard (external chain 0 by convention).
export function parseFeeKey(input, branchDefault = 0) {
  let s = (input || "").trim();
  if (s.startsWith("tr(")) {
    s = s.slice(3).replace(/\)(#[a-z0-9]+)?\s*$/i, "");   // strip `tr(` … `)` and any `#checksum`
    s = s.replace(/^\[[^\]]*\]/, "");                      // strip `[fingerprint/origin]`
    const [xpub, ...path] = s.split("/");
    const nums = path.filter((p) => p !== "*" && p !== "");
    return { xpub, branch: nums.length ? Number(nums[nums.length - 1]) : branchDefault };
  }
  return { xpub: s, branch: branchDefault };
}

// The fresh fee address for a given index. `keySpec` is a descriptor or xpub; `network` selects the hrp.
export function feeAddress(keySpec, index, network = "mainnet", branchOverride = null) {
  const { xpub, branch } = parseFeeKey(keySpec, 0);
  const hrp = BTC_HRP[network] || BTC_HRP.mainnet;
  const b = branchOverride != null ? branchOverride : branch;
  const acct = parseXpub(xpub);
  const chain = ckdPub(acct.pub, acct.cc, b);              // …/branch
  const leaf = ckdPub(chain.pub, chain.cc, index);         // …/branch/index
  return p2trAddress(leaf.pub, hrp);
}

// Validate a configured key eagerly (so a bad descriptor fails loudly at startup, not mid-swap).
export function validateFeeKey(keySpec, network = "mainnet") {
  return feeAddress(keySpec, 0, network);   // throws if the descriptor/xpub is malformed
}
