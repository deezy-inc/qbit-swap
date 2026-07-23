// Store abstraction: the sqlite backend does per-row UPSERTs (O(1) per change, not a full rewrite),
// stays document-shaped (whole swap as a JSON column) yet queryable via JSON1, migrates an existing JSON
// snapshot on first boot, and survives a restart. Also checks the JSON backend still round-trips.
//   Run:  node store.test.mjs
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { makeStore } from "./store.js";

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const dir = new URL(".", import.meta.url).pathname;
const clean = (base) => { for (const ext of ["", "-wal", "-shm", ".tmp"]) rmSync(dir + base + ext, { force: true }); };

// ── sqlite backend: per-row upsert + JSON1 query ─────────────────────────────────────────────────
clean("_store_test.db"); clean("_store_test.json");
{
  const s = makeStore(dir + "_store_test.db");
  ck(s.backend === "sqlite", "COORD_DB ending in .db selects the sqlite backend");
  s.put({ id: "swap1", state: "READY", terms: { btcSats: 20000000, qbtSats: 1e8 }, _sig: "x", presence: { a: 1 } });
  s.put({ id: "swap2", state: "READY", orderId: "ord9", terms: { btcSats: 5e7, qbtSats: 3e8 } });
  s.put({ id: "swap1", state: "COMPLETE", settledAt: 1234, terms: { btcSats: 20000000, qbtSats: 1e8 } });   // UPSERT same id
  const rows = s.load();
  ck(rows.length === 2, "upsert on the same id updates in place (2 rows, not 3)");
  ck(rows.find((r) => r.id === "swap1").state === "COMPLETE", "the row reflects the latest state");
  ck(rows.every((r) => !("_sig" in r) && !("presence" in r)), "ephemeral fields stripped before persisting");
  // JSON1: query INTO the document without deserializing everything in JS
  const done = s.query("SELECT id, json_extract(data,'$.terms.btcSats') AS btc FROM swaps WHERE state='COMPLETE'");
  ck(done.length === 1 && done[0].id === "swap1" && Number(done[0].btc) === 20000000, "JSON1 query reaches into the doc (json_extract on the blob)");
  const byOrder = s.query("SELECT id FROM swaps WHERE order_id=?", "ord9");
  ck(byOrder.length === 1 && byOrder[0].id === "swap2", "indexed column query by orderId works");
  s.db.close();
}
// restart: a fresh store over the same file loads the rows back
{
  const s2 = makeStore(dir + "_store_test.db");
  ck(s2.load().length === 2, "a restarted coordinator loads persisted swaps from sqlite");
  s2.db.close();
}
clean("_store_test.db");

// ── migration: a new .db next to an existing JSON snapshot imports it on first boot ───────────────
writeFileSync(dir + "_store_test.json", JSON.stringify([{ id: "old1", state: "COMPLETE" }, { id: "old2", state: "REFUNDED" }]));
{
  const s = makeStore(dir + "_store_test.db");
  const ids = s.load().map((r) => r.id).sort();
  ck(ids.join() === "old1,old2", "empty .db imports the sibling .json snapshot (one-time migration)");
  s.db.close();
}
clean("_store_test.db"); clean("_store_test.json");

// ── JSON backend still works (atomic snapshot) + memory backend is a no-op ────────────────────────
{
  const j = makeStore(dir + "_store_test.json", () => [{ id: "j1", state: "READY", _sig: "z" }]);
  ck(j.backend === "json", ".json path selects the JSON backend");
  j.put();
  ck(JSON.parse(readFileSync(dir + "_store_test.json", "utf8"))[0].id === "j1" && existsSync(dir + "_store_test.json"), "JSON backend writes the snapshot");
}
clean("_store_test.json");
const m = makeStore(null);
ck(m.backend === "memory" && m.load().length === 0, "no COORD_DB → memory backend (no persistence)");

console.log(ok ? "\nPASS — sqlite per-row store: upsert, JSON1 query, migration, reload; JSON + memory backends intact" : "\nFAIL");
process.exit(ok ? 0 : 1);
