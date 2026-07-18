// Validate the WASM SLH-DSA signer against golden vectors and the native pqcsign (byte-for-byte).
const { execFileSync } = require("child_process");
const PQCModule = require("./pqc_signer.js");

const H = (s) => Buffer.from(s, "hex");
// golden: keygen(random_data = 0x20 x128) -> this pubkey (== the p2mr golden witness-vector key)
const GOLDEN_RD = Buffer.alloc(128, 0x20);
const GOLDEN_PK = "ff39b4fff5f270b8f8ab3f45cb830aae5962993b0c839087550bef40903f571e";
// a controlled keypair (vanity --seed 0x11*32): sk = 64 bytes, pk = last 32 bytes of sk
const SK = "21d53e8c37f8b27e965881c331e20f75019cacd578a91f593309ecdb2c6b9a3bd6c2b3977708d7de974059b650874bc1555ff3194962627737f97dbaefe3dd39";
const PK = SK.slice(64);                       // d6c2b397...
const MSG = "f56df8a17d5e1bd271bf621d18eb5a26d7d7787c3ad79d708094473a189de264"; // golden P2MR sighash

PQCModule().then((m) => {
  const put = (buf) => { const p = m._malloc(buf.length); m.HEAPU8.set(buf, p); return p; };
  const get = (p, n) => Buffer.from(m.HEAPU8.subarray(p, p + n));
  const SIG_SIZE = m._pqc_sig_size(), SK_SIZE = m._pqc_sk_size();
  let pass = true;
  const check = (name, ok, extra="") => { console.log(`[${ok ? "ok" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`); pass = pass && ok; };

  check("sizes", SIG_SIZE === 3680 && SK_SIZE === 64, `sig=${SIG_SIZE} sk=${SK_SIZE}`);

  // 1) keygen golden vector
  const rdP = put(GOLDEN_RD), pkP = m._malloc(32), skP = m._malloc(64);
  m._pqc_keygen(rdP, pkP, skP);
  check("keygen(0x20x128) matches golden pubkey", get(pkP, 32).toString("hex") === GOLDEN_PK);

  // 2) sign in WASM, compare byte-for-byte to native pqcsign (SLH-DSA is deterministic)
  const skP2 = put(H(SK)), msgP = put(H(MSG)), sigP = m._malloc(SIG_SIZE), slP = m._malloc(4);
  const rc = m._pqc_sign(skP2, msgP, 32, sigP, slP);
  const siglen = m.HEAP32[slP >> 2];
  const sigWasm = get(sigP, siglen);
  const sigNative = Buffer.from(execFileSync(__dirname + "/../pqcsign", [SK, MSG]).toString().trim(), "hex");
  check("sign returns 0 + 3680 bytes", rc === 0 && siglen === 3680, `rc=${rc} len=${siglen}`);
  check("WASM signature == native pqcsign (byte-for-byte)", sigWasm.equals(sigNative));

  // 3) verify the WASM signature against the pubkey
  const vpkP = put(H(PK));
  check("verify(sig, msg, pk) == valid", m._pqc_verify(sigP, siglen, msgP, 32, vpkP) === 0);

  // 4) tamper -> must fail
  const bad = Buffer.from(sigWasm); bad[100] ^= 0xff; const badP = put(bad);
  check("verify rejects a tampered signature", m._pqc_verify(badP, siglen, msgP, 32, vpkP) !== 0);

  console.log("\n" + (pass ? "ALL PASS — WASM SLH-DSA signer matches the node's crypto" : "FAILURES ABOVE"));
  process.exit(pass ? 0 : 1);
});
