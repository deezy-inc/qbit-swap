// Validate the watch-only fee-address derivation against BIP86's official test vectors (the standard
// taproot single-key derivation). Pure crypto — no network, no chain.  Run:  node feeaddr.test.mjs
import { feeAddress, parseFeeKey } from "./feeaddr.js";

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };

// BIP86 account xpub (m/86'/0'/0' from the "abandon…about" mnemonic).
const XPUB = "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";

// External chain 0/index — the receive addresses the coordinator will hand out.
ck(feeAddress(XPUB, 0, "mainnet") === "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", "BIP86 0/0 matches the reference address");
ck(feeAddress(XPUB, 1, "mainnet") === "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh", "BIP86 0/1 matches (fresh address per index)");
// Internal chain 1/0 (branch override) — proves branch selection.
ck(feeAddress(XPUB, 0, "mainnet", 1) === "bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7", "BIP86 1/0 matches (branch selectable)");

// Descriptor form: tr([origin]xpub/0/*) must parse to the same xpub + external branch.
const desc = `tr([73c5da0a/86h/0h/0h]${XPUB}/0/*)`;
const parsed = parseFeeKey(desc);
ck(parsed.xpub === XPUB && parsed.branch === 0, "tr(...) descriptor parses to xpub + branch 0");
ck(feeAddress(desc, 0, "mainnet") === "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", "descriptor derives the same 0/0 address");
// A change descriptor `/1/*` selects the internal branch.
ck(feeAddress(`tr(${XPUB}/1/*)`, 0, "mainnet") === "bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7", "descriptor /1/* selects the change branch");

// Network hrp: same key, regtest address prefix.
ck(feeAddress(XPUB, 0, "regtest").startsWith("bcrt1p"), "regtest yields a bcrt1p… taproot address");
ck(feeAddress(XPUB, 0, "testnet").startsWith("tb1p"), "testnet yields a tb1p… taproot address");

// A private xprv must be rejected (we only ever accept watch-only public keys).
let threw = false;
try { feeAddress("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi", 0, "mainnet"); }
catch { threw = true; }
ck(threw, "an xprv (private key) is refused");

console.log("\n" + (ok ? "ALL PASS — BIP86 watch-only fee-address derivation" : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
