// Browser SLH-DSA signer — same API as signer.js, backed by the self-contained ESM WASM module
// (wasm embedded via SINGLE_FILE, ENVIRONMENT=web). No Node APIs, so it runs in the browser/worker.
// A bundler's "browser" resolution swaps signer.js -> this file automatically (see package.json).
import PQCModule from "./wasm/pqc_signer.web.mjs";

let mod;
async function ready() { if (!mod) mod = await PQCModule(); return mod; }
const put = (m, b) => { const p = m._malloc(b.length); m.HEAPU8.set(b, p); return p; };

export async function slhDsaSign(sk, msg) {           // sk: 64 bytes, msg: 32-byte digest -> 3680-byte sig
  const m = await ready();
  const skP = put(m, sk), msgP = put(m, msg), sigP = m._malloc(m._pqc_sig_size()), slP = m._malloc(4);
  if (m._pqc_sign(skP, msgP, msg.length, sigP, slP) !== 0) throw new Error("SLH-DSA sign failed");
  return m.HEAPU8.slice(sigP, sigP + m.HEAP32[slP >> 2]);
}
export async function slhDsaKeygen(randomData128) {   // -> { pk: 32, sk: 64 }
  const m = await ready();
  const rdP = put(m, randomData128), pkP = m._malloc(32), skP = m._malloc(64);
  if (m._pqc_keygen(rdP, pkP, skP) !== 0) throw new Error("keygen failed");
  return { pk: m.HEAPU8.slice(pkP, pkP + 32), sk: m.HEAPU8.slice(skP, skP + 64) };
}
