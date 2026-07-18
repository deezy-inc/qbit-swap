// CLI: node wasmsign.js <sk64hex> <msg32hex>  ->  prints the SLH-DSA signature hex (via WASM)
const PQCModule = require("./pqc_signer.js");
const [sk, msg] = process.argv.slice(2);
PQCModule().then((m) => {
  const put = (b) => { const p = m._malloc(b.length); m.HEAPU8.set(b, p); return p; };
  const skP = put(Buffer.from(sk, "hex")), msgP = put(Buffer.from(msg, "hex"));
  const sigP = m._malloc(m._pqc_sig_size()), slP = m._malloc(4);
  if (m._pqc_sign(skP, msgP, Buffer.from(msg, "hex").length, sigP, slP) !== 0) { console.error("sign failed"); process.exit(1); }
  const len = m.HEAP32[slP >> 2];
  process.stdout.write(Buffer.from(m.HEAPU8.subarray(sigP, sigP + len)).toString("hex"));
});
