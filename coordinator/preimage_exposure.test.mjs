// SECURITY INVARIANT: a swap's preimage (the initiator's secret) must NEVER reach an API response
// while it is still secret. The coordinator only ever HOLDS the preimage after the revealing claim tx
// has been broadcast to a public chain (applyEffects extracts it from the tx witness, post-broadcast),
// so there is never a still-secret preimage in memory for view() to leak. This test locks three things:
//   1) no client write endpoint can INJECT a preimage into swap state (submitParty drops extra fields),
//   2) the per-party view() exposes preimage only from s.preimage (null until the on-chain reveal), to
//      either party, and never leaks the per-swap tokens,
//   3) a source-level guard: s.preimage has exactly ONE writer, inside applyEffects (post-broadcast).
// Run:  node preimage_exposure.test.mjs
process.env.COORD_CHAIN = "dev";                 // no real chain adapter
globalThis.fetch = async () => { throw new Error("no network in this test"); };
import { readFileSync } from "node:fs";
const { createSwap, submitParty, roleOf, view } = await import("./swap.js");

let ok = true;
const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const PRE = "41".repeat(32), SECRET = "42".repeat(32), H = "e3".repeat(32);
const pub = (n) => ({ qbitPub: `q${n}`, btcPub: `b${n}`, btcDest: `bd${n}`, qbitDest: `qd${n}` });
const mk = () => createSwap({ btcSats: 100000, qbtSats: 500000000 });

// ── 1) INJECTION: a party can't sneak a preimage in through submitParty ──────────────────────────────
// (submit ONE party per swap so the alice+bob+H trigger for deriveHtlcs — which needs a chain — never fires)
{
  const s = mk();
  submitParty(s, "alice", { ...pub("A"), H, preimage: PRE, secret: SECRET });   // alice: malicious extra fields
  ck(!("preimage" in s.party.alice) && !("secret" in s.party.alice), "submitParty stores only pubkeys/dests — drops injected preimage/secret");
  ck(s.preimage === null, "alice's injected preimage did NOT reach s.preimage");
  ck(s.H === H, "alice CAN set H (the public hash commitment) — that's not the secret");
}
{
  const s = mk();
  submitParty(s, "bob", { ...pub("B"), H: "beefbeef", preimage: PRE, secret: SECRET });   // bob tries too
  ck(Object.keys(s.party.bob).sort().join() === "btcDest,btcPub,qbitDest,qbitPub", "bob's party record is pubkeys/dests only");
  ck(s.preimage === null, "bob's injected preimage did NOT reach s.preimage");
  ck(s.H === null, "bob CANNOT set H (only the initiator commits the hash)");
}

// ── 2) TOKEN GATING + view() exposure ────────────────────────────────────────────────────────────────
{
  const s = mk();
  submitParty(s, "alice", pub("A"));
  ck(roleOf(s, "") === null && roleOf(s, "not-a-token") === null, "roleOf: empty/unknown token → null (no default role → server 401s)");
  ck(roleOf(s, s.tokens.alice) === "alice" && roleOf(s, s.tokens.bob) === "bob", "roleOf: exact per-swap token → correct role");

  // pre-reveal: neither party's view exposes a preimage (there is none)
  ck(view(s, "bob").preimage === null, "pre-reveal: bob's view has preimage=null (the wrong-party case)");
  ck(view(s, "alice").preimage === null, "pre-reveal: alice's view has preimage=null");
  const dump = JSON.stringify(view(s, "bob"));
  ck(!dump.includes(s.tokens.alice) && !dump.includes(s.tokens.bob), "view() never leaks either party's swap token");

  // post-reveal: applyEffects would set s.preimage ONLY from an already-broadcast (public) claim tx.
  // Simulate that end state; both parties may now see it — bob NEEDS it to claim his BTC. Intended.
  s.preimage = PRE;
  ck(view(s, "alice").preimage === PRE && view(s, "bob").preimage === PRE, "post-reveal (public on-chain): both parties see the preimage — the intended completion path");
}

// ── 3) SOURCE GUARD: every writer of s.preimage extracts it from a verified on-chain witness ──────────
// Two writers now: applyEffects (coordinator/watchtower broadcast) and poll()'s out-of-band backfill (for
// a claim a party broadcast directly). BOTH must set s.preimage ONLY from a claim-tx witness item that
// hashes to s.H — never from client input — so the "public-once-on-chain" invariant still holds.
{
  const src = readFileSync(new URL("./swap.js", import.meta.url), "utf8");
  const writes = [...src.matchAll(/\bs\.preimage\s*=(?!=)/g)];   // assignments only, not ==/===
  ck(writes.length === 2, `s.preimage has exactly two (witness-gated) assignments in swap.js (found ${writes.length})`);
  const guarded = writes.every((w) => /wit\.find\([^;]*hex\(sha256\(bin\(x\)\)\)\s*===\s*s\.H/.test(src.slice(Math.max(0, w.index - 260), w.index)));
  ck(guarded, "every s.preimage assignment is gated on a witness item hashing to s.H (from a broadcast tx, never client input)");
}

console.log(ok ? "\nPASS — preimage is never injectable and never exposed pre-reveal; only public-once-on-chain" : "\nFAIL");
process.exit(ok ? 0 : 1);
