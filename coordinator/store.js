// Pluggable persistence for the swap store. The engine keeps ALL state in memory (that's the source of
// truth); this just checkpoints it durably so a restart resumes in-flight swaps + re-arms the watchtower.
// The engine calls put(swap) on every state change and load() once on boot. Backend by COORD_DB's shape:
//   unset          → memory only (no persistence)
//   *.db / *.sqlite → node:sqlite: ONE row per swap, UPSERTed per change — O(1) per touch(), not a full
//                     rewrite; the whole swap is a JSON column so it stays document-shaped, and JSON1
//                     (json_extract/->>) makes it queryable/indexable. Scales to real volume.
//   otherwise      → JSON snapshot, written atomically (temp+rename). Simple, but rewrites the whole file
//                     on every change — fine at low volume, the reason the .db backend exists.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const strip = ({ _sig, _online, presence, ...s }) => s;   // drop ephemeral fields before persisting

export function makeStore(path, getAll) {
  if (!path) return { backend: "memory", load: () => [], put: () => {} };
  if (/\.(db|sqlite)$/i.test(path)) return sqliteStore(path);
  return jsonStore(path, getAll);
}

function jsonStore(path, getAll) {
  return {
    backend: "json",
    load() { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return []; } },
    // Atomic full-file write: temp + rename, so power-loss mid-write can't truncate the live snapshot.
    put() { try { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(getAll().map(strip))); renameSync(tmp, path); } catch { /* best effort */ } },
  };
}

function sqliteStore(path) {
  // Swallow node:sqlite's one-time "experimental" ExperimentalWarning (keep the log clean); pass the rest.
  const emit = process.emitWarning.bind(process);
  process.emitWarning = (w, ...r) => (String(w).includes("SQLite is an experimental") ? undefined : emit(w, ...r));
  const db = new DatabaseSync(path);
  process.emitWarning = emit;
  db.exec("PRAGMA journal_mode=WAL");        // concurrent readers (query it live from elsewhere) + crash-safe
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS swaps(id TEXT PRIMARY KEY, state TEXT, order_id TEXT, settled_at INTEGER, updated_at INTEGER, data TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS ix_swaps_state ON swaps(state)");
  db.exec("CREATE INDEX IF NOT EXISTS ix_swaps_order ON swaps(order_id)");
  const upsert = db.prepare(`INSERT INTO swaps(id,state,order_id,settled_at,updated_at,data) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state, order_id=excluded.order_id, settled_at=excluded.settled_at, updated_at=excluded.updated_at, data=excluded.data`);
  const selectAll = db.prepare("SELECT data FROM swaps");
  const store = {
    backend: "sqlite",
    load() { return selectAll.all().map((r) => JSON.parse(r.data)); },
    put(swap) { const s = strip(swap); upsert.run(s.id, s.state ?? null, s.orderId ?? null, s.settledAt ?? null, Date.now(), JSON.stringify(s)); },   // one row, O(1)
    query(sql, ...params) { return db.prepare(sql).all(...params); },   // ad-hoc read (admin / external tooling)
    db,
  };
  // One-time migration: a fresh .db sitting next to the old JSON snapshot imports it, so switching prod is
  // just pointing COORD_DB at <name>.db — the existing <name>.json is picked up on first boot.
  if (selectAll.all().length === 0) {
    const legacy = path.replace(/\.(db|sqlite)$/i, ".json");
    if (existsSync(legacy)) {
      try { const rows = JSON.parse(readFileSync(legacy, "utf8")); for (const s of rows) store.put(s); console.log(`[store] migrated ${rows.length} swaps from ${legacy} → ${path}`); }
      catch (e) { console.error(`[store] JSON→sqlite migration failed: ${e.message}`); }
    }
  }
  return store;
}
