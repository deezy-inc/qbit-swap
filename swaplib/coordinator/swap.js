// Keyless swap model + Tier-Nolan state machine, BIDIRECTIONAL. The coordinator never holds keys,
// preimages (until public), or funds. It derives the two HTLC addresses, watches both chains, gates
// the initiator's claim on reorg-safe confirmations, surfaces refundability once timelocks pass,
// broadcasts party-signed txs, and surfaces the revealed preimage. Optional JSON persistence + a
// change pub/sub feed the API/SSE.
//
// Roles are direction-neutral: the CREATOR is the initiator (holds the secret); the joiner is the
// participant. `direction` says which coin the initiator sends:
//   "btc2qbt": initiator sends BTC (fromLeg), receives QBT (toLeg)
//   "qbt2btc": initiator sends QBT (fromLeg), receives BTC (toLeg)
// The initiator funds fromLeg (longer timelock) and claims toLeg (shorter timelock, revealing the
// preimage); the participant funds toLeg and claims fromLeg with the now-public preimage.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import {
  htlcWitnessScript, p2wshSpk, p2wshAddr,          // BTC leg
  htlcLeafQbit, p2mrSpk, p2mrAddress,               // QBT leg
  parseTx, serializeTx,                             // for splicing the preimage into a pre-signed claim
} from "../js/index.js";
import { qbit, btc } from "./chain.js";
import { btcFeerates, cachedBtcFeerates, cachedQbitFeerates } from "./fees.js";

export const States = ["CREATED", "READY", "FROM_FUNDED", "TO_FUNDED", "MATURING", "CLAIMABLE", "CLAIMED", "COMPLETE", "REFUNDED", "ABORTED"];
const TERMINAL = ["COMPLETE", "REFUNDED", "ABORTED"];
const legsFor = (direction) => (direction === "qbt2btc" ? { fromLeg: "qbit", toLeg: "btc" } : { fromLeg: "btc", toLeg: "qbit" });
const chainOf = (leg) => (leg === "btc" ? btc : qbit);

const swaps = new Map();
const token = () => randomBytes(16).toString("hex");

// ── persistence (optional JSON snapshot; set COORD_DB) ────────────────────────
const DB_PATH = process.env.COORD_DB || null;
function persist() {
  if (!DB_PATH) return;
  const dump = [...swaps.values()].map(({ _sig, _online, presence, ...s }) => s);   // presence is ephemeral
  try { writeFileSync(DB_PATH, JSON.stringify(dump)); } catch { /* best effort */ }
}
function load() {
  if (!DB_PATH) return;
  try { for (const s of JSON.parse(readFileSync(DB_PATH, "utf8"))) swaps.set(s.id, s); } catch { /* fresh start */ }
}
load();

// ── change pub/sub (drives SSE) ───────────────────────────────────────────────
const subs = new Map();
export function subscribe(id, cb) {
  if (!subs.has(id)) subs.set(id, new Set());
  subs.get(id).add(cb);
  return () => subs.get(id)?.delete(cb);
}
// Global subscription: fires on ANY swap's change. Drives the admin dashboard's live feed.
const allSubs = new Set();
export function subscribeAll(cb) { allSubs.add(cb); return () => allSubs.delete(cb); }
const sigOf = (s) => JSON.stringify({ st: s.state, f: s.funding, r: s.refund, p: s.preimage, b: s.broadcasts, fn: [!!s.finish?.alice, !!s.finish?.bob] });
function emit(s) {
  for (const cb of subs.get(s.id) || []) { try { cb(s); } catch { /* dead listener */ } }
  for (const cb of allSubs) { try { cb(s); } catch { /* dead listener */ } }
}
function touch(s) {
  const g = sigOf(s);
  if (g === s._sig) return s;
  s._sig = g; persist();
  emit(s);
  return s;
}

// ── presence (drives "counterparty online") ──────────────────────────────────
// A role is online if it holds an open SSE connection OR has hit the API recently — so both a browser
// (SSE) and a polling bot register, with no extra ping endpoint. Transitions push to the counterparty.
const ONLINE_MS = 15000;
const nowMs = () => Date.now();
const presenceOf = (s) => (s.presence ||= { alice: { sse: 0, seen: 0 }, bob: { sse: 0, seen: 0 } });
export const isOnline = (s, role) => { const p = presenceOf(s)[role]; return p.sse > 0 || nowMs() - p.seen < ONLINE_MS; };
function onPresenceChange(s, role, mutate) { const before = isOnline(s, role); mutate(presenceOf(s)[role]); if (isOnline(s, role) !== before) emit(s); }
export function markSeen(id, role) { const s = swaps.get(id); if (s) onPresenceChange(s, role, (p) => { p.seen = nowMs(); }); }
export function addConnection(id, role) { const s = swaps.get(id); if (s) onPresenceChange(s, role, (p) => { p.sse++; p.seen = nowMs(); }); }
export function dropConnection(id, role) { const s = swaps.get(id); if (s) onPresenceChange(s, role, (p) => { p.sse = Math.max(0, p.sse - 1); }); }
// Periodic sweep so a client going silent (last-seen expiry) flips the counterparty to offline.
export function sweepPresence() {
  for (const s of swaps.values()) {
    const o = { alice: isOnline(s, "alice"), bob: isOnline(s, "bob") };
    if (!s._online || s._online.alice !== o.alice || s._online.bob !== o.bob) { s._online = o; emit(s); }
  }
}

const MIN_SATS = { btc: Number(process.env.MIN_BTC_SATS || 50000), qbit: Number(process.env.MIN_QBT_SATS || 200000) };   // above the largest claim/refund fee + dust

// Network hrp for the HTLC deposit addresses the coordinator hands out. MUST match the deploy network
// (regtest bcrt/qbrt · testnet tb/tqb · mainnet bc/qb) or users get an unspendable address.
const HRP = { btc: process.env.BTC_HRP || "bcrt", qbit: process.env.QBIT_HRP || "qbrt" };

// ── HTLC timelocks, in WALL-CLOCK time (not raw blocks) ───────────────────────────────────────
// Tier-Nolan safety: the initiator's leg (fromLeg) must stay refundable LONGER — in real time — than
// the participant's leg (toLeg), so the participant is forced to reveal the preimage (claiming their
// leg) before the initiator can refund, and the initiator still has time to claim after the reveal.
// BTC (~10 min) and QBT (~60 s) have very different block times, so a fixed BLOCK count would invert
// this ordering in one direction. We instead pick wall-clock windows and convert each to that chain's
// block count via its block time. For regtest the lab sets tiny values so tests stay fast.
const BLOCK_SECS = { btc: Number(process.env.BTC_BLOCK_SECS || 600), qbit: Number(process.env.QBIT_BLOCK_SECS || 60) };
const HTLC_TO_SECS = Number(process.env.HTLC_TO_SECS || 12 * 3600);     // participant's (shorter) window
const HTLC_FROM_SECS = Number(process.env.HTLC_FROM_SECS || 24 * 3600); // initiator's (longer) window
if (!(HTLC_FROM_SECS > HTLC_TO_SECS)) throw new Error("HTLC_FROM_SECS must exceed HTLC_TO_SECS — the initiator's leg has to outlast the participant's");
const locktimeBlocks = (leg, secs) => Math.max(1, Math.ceil(secs / BLOCK_SECS[leg]));
export function createSwap({ btcSats, qbtSats, securityLevel = "high", direction = "btc2qbt" }) {
  if (direction !== "btc2qbt" && direction !== "qbt2btc") throw new Error("bad direction");
  // Reject dust-level swaps: the amount must comfortably exceed claim/refund fees (incl. the top
  // watchtower fee tier) or the spend would produce a dust/negative output.
  if (!(btcSats >= MIN_SATS.btc) || !(qbtSats >= MIN_SATS.qbit)) throw new Error(`amount too small (min ${MIN_SATS.btc} btc / ${MIN_SATS.qbit} qbt sats)`);
  const s = {
    id: token(), tokens: { alice: token(), bob: token() },
    terms: { btcSats, qbtSats, securityLevel, direction },
    roles: legsFor(direction),             // { fromLeg, toLeg } — initiator funds fromLeg, claims toLeg
    state: "CREATED", H: null,
    party: { alice: null, bob: null },
    locktimes: null, htlc: null,
    funding: { btc: null, qbit: null },
    heights: null, refund: null,
    confsTarget: null, preimage: null,
    finish: { alice: null, bob: null },    // watchtower: each party's pre-signed { claim(ladder), refund }
    wt: {},                                // watchtower broadcast tracking (role:kind -> {txid,tier,at})
    broadcasts: {}, createdAt: Date.now(),
  };
  swaps.set(s.id, s);
  touch(s);
  return s;
}
export const getSwap = (id) => swaps.get(id);
export const roleOf = (s, tok) => (tok === s.tokens.alice ? "alice" : tok === s.tokens.bob ? "bob" : null);
export const allSwaps = () => [...swaps.values()];

// Party submits pubkeys + destination addresses. The creator (alice/initiator) also submits H.
export async function submitParty(s, role, data) {
  if (s.state !== "CREATED" && s.state !== "READY") throw new Error("party data locked");
  // First-come lock: once a slot is filled it can't be overwritten by different keys. This makes a
  // shared link single-use — a second person opening the same link is rejected rather than racing to
  // replace the participant (which could leave the first funder's deposit keyed to someone else). The
  // same party reconnecting (same keys, e.g. from their backup) is idempotent and allowed.
  const existing = s.party[role];
  if (existing && (existing.qbitPub !== data.qbitPub || existing.btcPub !== data.btcPub)) throw new Error("this swap has already been joined by someone else");
  if (role === "alice" && data.H) s.H = data.H;
  s.party[role] = { qbitPub: data.qbitPub, btcPub: data.btcPub, btcDest: data.btcDest, qbitDest: data.qbitDest };
  if (s.party.alice && s.party.bob && s.H) await deriveHtlcs(s);
  return touch(s);
}

async function deriveHtlcs(s) {
  const H = bin(s.H);
  const [qh, bh] = [await qbit.height(), await btc.height()];
  const { fromLeg, toLeg } = s.roles;
  const A = s.party.alice, B = s.party.bob;   // A = initiator, B = participant
  // fromLeg (initiator funds) gets the LONGER wall-clock window; toLeg (participant funds) the SHORTER
  // one. Each window is converted to a block count on its OWN chain, so the real-time ordering holds
  // regardless of which coin is on which leg.
  const lock = { qbit: qh, btc: bh };
  lock[fromLeg] += locktimeBlocks(fromLeg, HTLC_FROM_SECS);
  lock[toLeg] += locktimeBlocks(toLeg, HTLC_TO_SECS);
  s.locktimes = lock;

  // Per leg: claim party + refund party. On fromLeg, participant claims (with public secret) &
  // initiator refunds. On toLeg, initiator claims (revealing secret) & participant refunds.
  const pub = (party, leg) => bin(leg === "qbit" ? s.party[party].qbitPub : s.party[party].btcPub);
  const build = (leg, claimParty, refundParty) => leg === "qbit"
    ? htlcLeafQbit(H, pub(claimParty, "qbit"), pub(refundParty, "qbit"), lock.qbit)
    : htlcWitnessScript(H, pub(claimParty, "btc"), pub(refundParty, "btc"), lock.btc);
  const fromScript = build(fromLeg, "bob", "alice");    // fromLeg: participant claims, initiator refunds
  const toScript = build(toLeg, "alice", "bob");        // toLeg:   initiator claims, participant refunds
  const pack = (leg, script) => leg === "qbit"
    ? { leaf: hex(script), spk: hex(p2mrSpk(script)), address: p2mrAddress(script, HRP.qbit) }
    : { witnessScript: hex(script), spk: hex(p2wshSpk(script)), address: p2wshAddr(script, HRP.btc) };
  s.htlc = { [fromLeg]: pack(fromLeg, fromScript), [toLeg]: pack(toLeg, toScript) };

  // Reorg-safe gate on the leg the initiator claims (toLeg). Qbit has the native engine; for a BTC
  // toLeg use a simple depth by security level.
  if (toLeg === "qbit") s.confsTarget = await qbit.confTarget(s.terms.qbtSats, s.terms.securityLevel);
  else s.confsTarget = { confs: ({ maximum: 6, high: 3, medium: 2, low: 1 })[s.terms.securityLevel] ?? 3, source: "btc-depth", level: s.terms.securityLevel };
  if (process.env.DEV_CONFS_CAP) s.confsTarget.confs = Math.min(s.confsTarget.confs, Number(process.env.DEV_CONFS_CAP));
  s.state = "READY";
}

// Watcher tick: detect funding on both legs, gate the initiator's claim on reorg-safe confs, surface
// refundability once timelocks pass, notice terminal on-chain spends. Pure chain reads.
export async function poll(s) {
  if (["CREATED", ...TERMINAL].includes(s.state)) return;
  const [qh, bh] = [await qbit.height(), await btc.height()];
  s.heights = { qbit: qh, btc: bh };
  const H = { qbit: qh, btc: bh };
  const { fromLeg, toLeg } = s.roles;

  // Only count a leg as funded when the deposit meets the agreed amount — otherwise a counterparty
  // could underfund their HTLC and short the other side. An underfunded leg is surfaced (shortFunded)
  // but doesn't progress the swap, so it stalls and the underfunder can refund after the timelock.
  const need = { btc: s.terms.btcSats, qbit: s.terms.qbtSats };
  for (const leg of ["btc", "qbit"]) if (!s.funding[leg]) {
    const o = await chainOf(leg).findOutput(s.htlc[leg].spk);
    if (o && o.amountSats >= need[leg]) s.funding[leg] = o;
    else if (o) s.shortFunded = { ...(s.shortFunded || {}), [leg]: { got: o.amountSats, need: need[leg] } };
  }
  for (const leg of ["btc", "qbit"]) if (s.funding[leg] && !s.funding[leg].spent && !(await chainOf(leg).isUnspent(s.funding[leg].txid, s.funding[leg].vout))) s.funding[leg].spent = true;

  const from = s.funding[fromLeg], to = s.funding[toLeg];
  // recompute the pre-claim state from ground truth (broadcast() owns CLAIMED/COMPLETE/REFUNDED)
  if (!["CLAIMED", ...TERMINAL].includes(s.state)) {
    let st = "READY";
    if (from) st = "FROM_FUNDED";
    if (to && !to.spent) {
      const confs = H[toLeg] - to.height + 1; to.confs = confs;
      st = from ? (confs >= s.confsTarget.confs ? "CLAIMABLE" : "MATURING") : "TO_FUNDED";
    }
    s.state = st;
  }
  if (s.preimage && to?.spent && from?.spent && !TERMINAL.includes(s.state)) { s.state = "COMPLETE"; s.settledAt = Date.now(); }

  // Refundability: initiator reclaims fromLeg after its (longer) timelock; participant reclaims toLeg
  // after its (shorter) timelock — each while their own deposit is still unspent.
  s.refund = {
    [fromLeg]: { party: "alice", at: s.locktimes[fromLeg], available: !!(from && !from.spent && H[fromLeg] >= s.locktimes[fromLeg]) },
    [toLeg]: { party: "bob", at: s.locktimes[toLeg], available: !!(to && !to.spent && !s.preimage && H[toLeg] >= s.locktimes[toLeg]) },
  };
  touch(s);
}

// Post-broadcast state effects, shared by party broadcasts and the watchtower. Any claim may carry the
// preimage in its witness — extract it so the counterparty can complete. The fromLeg claim (the
// participant taking the initiator's coin) is the final step -> COMPLETE.
async function applyEffects(s, leg, kind, txid) {
  s.broadcasts[`${leg}:${kind}`] = txid;
  if (kind === "claim") {
    const wit = (await chainOf(leg).getTx(txid)).vin[0].txinwitness || [];
    const pre = wit.find((x) => x.length === 64 && hex(sha256(bin(x))) === s.H);
    if (pre && !s.preimage) s.preimage = pre;
    if (s.funding[leg]) s.funding[leg].spent = true;
    if (leg === s.roles.fromLeg) { s.state = "COMPLETE"; s.settledAt = Date.now(); } else s.state = "CLAIMED";
  }
  if (kind === "refund") { if (s.funding[leg]) s.funding[leg].spent = true; s.state = "REFUNDED"; s.settledAt = Date.now(); }
}
// A party submits a signed tx; the coordinator broadcasts it (keyless).
export async function broadcast(s, leg, kind, txHex) {
  const chain = chainOf(leg);
  const acc = await chain.testAccept(txHex);
  if (!acc.allowed) throw new Error(`rejected: ${acc.reason}`);
  const txid = await chain.broadcast(txHex);
  await applyEffects(s, leg, kind, txid);
  return { txid, state: touch(s).state };
}

// ── watchtower ────────────────────────────────────────────────────────────────
// Each party pre-signs a fee-ladder claim + a refund (`submitFinish`); the coordinator broadcasts them
// on their behalf so a swap completes/refunds even if both tabs close. Non-custodial: every stored tx
// pays only its owner's address, and the coordinator holds no keys — it can only help, never redirect.
export function submitFinish(s, role, bundle) {
  if (!bundle?.claim?.tiers?.length || !bundle?.refund?.tx) throw new Error("finish bundle needs claim.tiers[] and refund.tx");
  s.finish[role] = bundle;
  return touch(s);
}
const splicePreimage = (txHex, preimageHex) => { const tx = parseTx(bin(txHex)); tx.wit[0][1] = bin(preimageHex); return hex(serializeTx(tx)); };
// Pick the cheapest pre-signed tier whose feerate beats the current mempool fastest fee (BTC); qbit or
// no fee data -> the lowest tier. `minIndex` lets escalation start above a previously-broadcast tier.
async function pickTier(leg, tiers, minIndex = 0) {
  if (leg !== "btc") return minIndex;
  const target = (await btcFeerates()).fastestFee || 1;
  for (let i = minIndex; i < tiers.length; i++) if (tiers[i].feerate >= target) return i;
  return tiers.length - 1;
}
async function wtSend(s, role, leg, kind, txHex, tier) {
  const chain = chainOf(leg);
  const acc = await chain.testAccept(txHex);
  if (!acc.allowed) return false;                 // already spent, or this tier too low right now — retry next tick/tier
  const txid = await chain.broadcast(txHex);
  s.wt[`${role}:${kind}`] = { txid, tier, at: s.heights?.[leg] ?? 0, ts: Date.now() };
  await applyEffects(s, leg, kind, txid);
  return true;
}
async function wtClaim(s, role, leg, minTier = 0) {
  const b = s.finish[role].claim;                 // { leg, needsPreimage, tiers:[{feerate,tx}] }
  const tier = await pickTier(leg, b.tiers, minTier);
  const txHex = b.needsPreimage ? splicePreimage(b.tiers[tier].tx, s.preimage) : b.tiers[tier].tx;
  return wtSend(s, role, leg, "claim", txHex, tier);
}
// Called every watcher tick. The watchtower is a FALLBACK: it only acts for a party that's actually
// OFFLINE (presence, with its ~15s grace) — an online client finishes its own swap, so the watchtower
// never races it. It drives the swap to completion (or refund) from that party's pre-signed bundle.
export async function driveWatchtower(s) {
  if (!s.roles || !s.htlc || ["CREATED", ...TERMINAL].includes(s.state)) return;
  const { fromLeg, toLeg } = s.roles, H = s.heights || {};
  const unspent = (leg) => s.funding[leg] && !s.funding[leg].spent;
  const away = (role) => !isOnline(s, role);   // only step in for a party that has left

  // a) offline initiator's claim of toLeg once matured -> reveals the preimage on-chain
  if (s.state === "CLAIMABLE" && away("alice") && s.finish.alice?.claim && unspent(toLeg) && !s.wt["alice:claim"]) await wtClaim(s, "alice", toLeg);
  // b) offline participant's claim of fromLeg once the preimage is public (spliced in)
  if (s.preimage && away("bob") && s.finish.bob?.claim && unspent(fromLeg) && !s.wt["bob:claim"]) await wtClaim(s, "bob", fromLeg);
  // c) abort refunds after each leg's timelock (only while no preimage — else the claim path applies)
  if (!s.preimage && s.locktimes) {
    if (away("alice") && s.finish.alice?.refund && unspent(fromLeg) && (H[fromLeg] || 0) >= s.locktimes[fromLeg] && !s.wt["alice:refund"]) await wtSend(s, "alice", fromLeg, "refund", s.finish.alice.refund.tx, "r");
    if (away("bob") && s.finish.bob?.refund && unspent(toLeg) && (H[toLeg] || 0) >= s.locktimes[toLeg] && !s.wt["bob:refund"]) await wtSend(s, "bob", toLeg, "refund", s.finish.bob.refund.tx, "r");
  }
  // d) fee escalation: if a broadcast claim fell out of the mempool (leg unspent again) and a higher
  //    tier exists, bump to it (full-RBF is the network default, so no RBF signaling is needed).
  for (const [role, leg] of [["alice", toLeg], ["bob", fromLeg]]) {
    const rec = s.wt[`${role}:claim`], b = s.finish[role]?.claim;
    if (rec && b && away(role) && unspent(leg) && rec.tier < b.tiers.length - 1) { s.wt[`${role}:claim`] = null; await wtClaim(s, role, leg, rec.tier + 1); }
  }
  touch(s);
}

// The view a party is allowed to see (both legs' public data; preimage only once on-chain).
export function view(s, role) {
  return {
    id: s.id, role, state: s.state, terms: s.terms, direction: s.terms.direction, roles: s.roles,
    H: s.H, locktimes: s.locktimes, htlc: s.htlc, funding: s.funding, heights: s.heights,
    confsTarget: s.confsTarget, refund: s.refund, feerates: { btc: cachedBtcFeerates(), qbit: cachedQbitFeerates() },
    counterparty: s.party[role === "alice" ? "bob" : "alice"], self: s.party[role],
    counterpartyOnline: isOnline(s, role === "alice" ? "bob" : "alice"), selfOnline: isOnline(s, role),
    safetyNet: { self: !!s.finish?.[role], counterparty: !!s.finish?.[role === "alice" ? "bob" : "alice"] },
    shortFunded: s.shortFunded || null,
    preimage: s.preimage, broadcasts: s.broadcasts,
  };
}
