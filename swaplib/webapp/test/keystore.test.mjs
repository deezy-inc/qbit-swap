// Headless test of the plaintext key store: backup export/import round-trip + IndexedDB-style vault.
import assert from "node:assert";
import { exportBackup, importBackup, Vault, memBackend } from "../src/keystore.js";

const secrets = { swapId: "abc123", role: "alice", direction: "btc2qbt", coordinator: "http://x", qbitSk: "aa".repeat(64), btcPriv: "bb".repeat(32), secret: "cc".repeat(32), H: "dd".repeat(32) };

const file = exportBackup(secrets);
assert.ok(JSON.parse(file).kind === "qbit-swap-backup", "backup tagged");
assert.deepEqual(importBackup(file), secrets, "backup round-trips to the same secrets");
assert.throws(() => importBackup(JSON.stringify({ hello: 1 })), "rejects a non-backup file");

const vault = new Vault(memBackend());
await vault.save(secrets);
assert.deepEqual((await vault.load("abc123")).swapId, "abc123", "vault load");
assert.deepEqual(await vault.list(), ["abc123"], "vault list");
await vault.purge("abc123");
assert.equal(await vault.load("abc123"), undefined, "vault purge");

console.log("keystore (plaintext): ALL PASS (backup round-trip, vault save/list/purge)");
