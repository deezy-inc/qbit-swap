// Non-custodial key store for a single swap. Per current product decision the secrets are kept in
// the CLEAR: a plaintext backup file the user downloads, plus a plaintext IndexedDB copy so a reload
// can resume. One file protects one short-lived swap; losing it can only ever lose that single swap
// (keys are ephemeral, no shared seed) — and a stalled swap still refunds, since the counterparty
// can't claim without the preimage. (An encrypted-envelope version — passphrase + passkey PRF — lived
// here earlier in git history; re-add it when we want at-rest protection.)

const KIND = "qbit-swap-backup";

// Plaintext backup: exactly the secrets needed to resume, complete, or refund the swap.
export function exportBackup(secrets) { return JSON.stringify({ kind: KIND, v: 1, ...secrets }, null, 2); }
export function importBackup(text) {
  const r = JSON.parse(text);
  if (r.kind !== KIND) throw new Error("not a qbit-swap backup file");
  const { kind, v, ...secrets } = r;
  return secrets;
}

// ── IndexedDB store (browser) + injectable backend (tests) ───────────────────
function idbBackend(dbName = "qbit-swap", store = "swaps") {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open(dbName, 1); r.onupgradeneeded = () => r.result.createObjectStore(store); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(store, mode); const s = t.objectStore(store); const rq = fn(s); t.oncomplete = () => res(rq?.result); t.onerror = () => rej(t.error); }); };
  return {
    get: (k) => tx("readonly", (s) => s.get(k)),
    set: (k, v) => tx("readwrite", (s) => s.put(v, k)),
    del: (k) => tx("readwrite", (s) => s.delete(k)),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
  };
}
export function memBackend() { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), del: (k) => void m.delete(k), keys: () => [...m.keys()] }; }

export class Vault {
  constructor(backend = typeof indexedDB !== "undefined" ? idbBackend() : memBackend()) { this.b = backend; }
  save(secrets) { return this.b.set(secrets.swapId, secrets); }   // plaintext secrets, keyed by swap id
  load(swapId) { return this.b.get(swapId); }
  purge(swapId) { return this.b.del(swapId); }
  list() { return this.b.keys(); }
}
