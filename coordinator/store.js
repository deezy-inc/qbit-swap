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
import { createRequire } from "node:module";

const strip = ({ _sig, _online, presence, ...s }) => s;   // drop ephemeral fields before persisting

export function makeStore(path, getAll) {
  if (!path) return { backend: "memory", load: () => [], put: () => {} };
  if (/\.(db|sqlite)$/i.test(path)) return sqliteStore(path, getAll);
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

function sqliteStore(path, getAll) {
  // Swallow node:sqlite's one-time "experimental" ExperimentalWarning (keep the log clean); pass the rest.
  const emit = process.emitWarning.bind(process);
  process.emitWarning = (w, ...r) => (String(w).includes("SQLite is an experimental") ? undefined : emit(w, ...r));
  // Load node:sqlite LAZILY (only when a .db path is actually configured) so importing this module never
  // crashes on a Node without it. Node < 22.5 has no node:sqlite → fall back to the JSON snapshot at the
  // sibling .json path (keeps the coordinator up and persisting) with a loud note to upgrade Node.
  let DatabaseSync;
  try { ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite")); } catch { /* older Node */ }
  if (!DatabaseSync) {
    process.emitWarning = emit;
    const legacy = path.replace(/\.(db|sqlite)$/i, ".json");
    console.error(`[store] node:sqlite unavailable (needs Node 22.5+; running ${process.version}) — persisting to JSON at ${legacy} instead. Upgrade Node to enable the sqlite backend.`);
    return jsonStore(legacy, getAll);
  }
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
  const selectOne = db.prepare("SELECT data FROM swaps WHERE id=?");
  const countByState = db.prepare("SELECT state, COUNT(*) n FROM swaps GROUP BY state");
  const completeVol = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CAST(json_extract(data,'$.terms.btcSats') AS INTEGER)),0) btc, COALESCE(SUM(CAST(json_extract(data,'$.terms.qbtSats') AS INTEGER)),0) qbt FROM swaps WHERE state='COMPLETE'");
  const recentComplete = db.prepare("SELECT data FROM swaps WHERE state='COMPLETE' ORDER BY settled_at DESC LIMIT ?");
  const store = {
    backend: "sqlite",
    load() { return selectAll.all().map((r) => JSON.parse(r.data)); },
    put(swap) { const s = strip(swap); upsert.run(s.id, s.state ?? null, s.orderId ?? null, s.settledAt ?? null, Date.now(), JSON.stringify(s)); },   // one row, O(1)
    get(id) { const r = selectOne.get(id); return r ? JSON.parse(r.data) : null; },        // load-on-demand for an evicted swap
    counts() { const o = {}; for (const r of countByState.all()) o[r.state] = r.n; return o; },   // full-history counts (incl. evicted)
    volume() { const r = completeVol.get(); return { complete: r.n, btcSats: r.btc, qbtSats: r.qbt }; },
    recent(limit) { return recentComplete.all(limit).map((r) => JSON.parse(r.data)); },
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
