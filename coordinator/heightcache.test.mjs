// The watcher polls every swap each tick and each poll() reads both chains' heights — so height() MUST
// cache the tip briefly or it fires 2×(active swaps) getblockcount RPCs per tick. This locks the cache:
// two reads inside the TTL = one RPC; a read after the TTL refreshes.  Run:  node heightcache.test.mjs
process.env.COORD_CHAIN = "dev";
process.env.HEIGHT_CACHE_MS = "1500";
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const { btc } = await import("./chain.js");

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stand the singleton up as an rpc backend with a call-counting getblockcount.
let calls = 0, tip = 800000;
btc.backend = "rpc";
btc.rpc = async (method) => { if (method === "getblockcount") { calls++; return tip; } return null; };
btc._h = undefined;   // clear any prior cache

const a = await btc.height();
const b = await btc.height();   // within TTL → cache hit, no second RPC
ck(a === 800000 && b === 800000, "height returns the tip");
ck(calls === 1, `two reads inside the TTL cost ONE getblockcount (got ${calls}) — not one-per-swap`);

// Simulate a busy tick: 50 polls' worth of height reads, still one RPC.
for (let i = 0; i < 50; i++) await btc.height();
ck(calls === 1, "50 reads inside the TTL still cost one RPC (the whole point at scale)");

tip = 800001;                   // a new block
await sleep(1600);              // let the TTL lapse
const c = await btc.height();
ck(calls === 2 && c === 800001, "a read after the TTL refreshes (picks up the new block)");

console.log(ok ? "\nPASS — tip height is cached per-tick, so poll() doesn't hammer getblockcount at scale" : "\nFAIL");
process.exit(ok ? 0 : 1);
