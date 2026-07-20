// Browser-side swap party. Generates ephemeral per-swap keys, creates/joins a swap through the
// coordinator's API, subscribes to its live feed, and signs its own claim/refund in-page (WASM SLH-DSA
// for the Qbit leg, ECDSA for the Bitcoin leg). The coordinator is keyless.
//
//   The QBT BUYER is the initiator (alice, holds the secret): funds fromLeg=BTC (longer timelock),
//   claims toLeg=QBT (revealing the preimage). The QBT SELLER is the participant (bob): funds QBT,
//   claims BTC with the now-public preimage. This holds no matter who created the link — the creator
//   simply keeps the alice (buyer) or bob (seller) token and shares the other. Every swap is btc2qbt.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import {
  slhDsaKeygen, slhDsaSign, compressedPub,
  p2mrSighash, serializeTx, P2MR_CONTROL_SINGLE_LEAF,
  btcSpend, addressToScriptPubKey,
  htlcLeafQbit, p2mrSpk, htlcWitnessScript, p2wshSpk,   // for independent HTLC verification
} from "@qbit-swap/client";

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export class SwapClient {
  constructor({ coordinator, onUpdate = () => {}, feeSats = { qbit: 100000, btc: 5000 }, btcHrp = "bc" }) {
    this.base = coordinator.replace(/\/$/, "");
    this.onUpdate = onUpdate;
    this.feeSats = feeSats;
    this.acted = new Set();
    // Direct-broadcast fallback for the BTC leg (see #send): public endpoints keyed by network. Qbit
    // has no public node, so only the coordinator can relay QBT. Regtest/unknown → no fallback.
    this.btcBroadcast = BTC_BROADCAST[btcHrp] || [];
  }

  // Retries transient failures (network drop, coordinator restart/blip, 5xx/429) so an in-flight
  // create/join/submit isn't lost to a momentary outage. A definitive 4xx (business error) is thrown
  // immediately — it won't succeed on retry.
  async #api(path, { token, method = "GET", body } = {}) {
    const headers = { "content-type": "application/json", ...(token ? { "x-swap-token": token } : {}) };
    for (let attempt = 0; ; attempt++) {
      let r;
      try { r = await fetch(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
      catch (e) { if (attempt >= 4) throw e; await new Promise((s) => setTimeout(s, 500 * (attempt + 1))); continue; }
      if (r.status >= 500 || r.status === 429) { if (attempt >= 4) throw new Error(`coordinator ${r.status}`); await new Promise((s) => setTimeout(s, 500 * (attempt + 1))); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      return j;
    }
  }

  // ── identity / persistence ───────────────────────────────────────────────────
  async #freshKeys(isInitiator) {
    this.qbit = await slhDsaKeygen(rand(128));
    this.btcPriv = rand(32);
    if (isInitiator) { this.secret = rand(32); this.H = sha256(this.secret); }   // only the initiator (alice) holds the secret
  }
  secrets() {
    return {
      swapId: this.id, role: this.role, direction: this.direction, token: this.token, coordinator: this.base,
      btcDest: this.btcDest, qbitDest: this.qbitDest,
      qbitPk: hex(this.qbit.pk), qbitSk: hex(this.qbit.sk), btcPriv: hex(this.btcPriv),
      secret: this.secret ? hex(this.secret) : null, H: this.H ? hex(this.H) : null,
      btcSats: this.terms?.btcSats ?? null, qbtSats: this.terms?.qbtSats ?? null,
      recovery: this.recovery || null,   // pre-signed watchtower ladder (claim tiers + refund), for offline recovery
    };
  }
  restore(p) {
    this.id = p.swapId; this.role = p.role; this.direction = p.direction; this.token = p.token; this.base = p.coordinator.replace(/\/$/, "");
    this.btcDest = p.btcDest; this.qbitDest = p.qbitDest;
    this.qbit = { pk: bin(p.qbitPk), sk: bin(p.qbitSk) }; this.btcPriv = bin(p.btcPriv);
    this.secret = p.secret ? bin(p.secret) : null; this.H = p.H ? bin(p.H) : null;
    this.terms = p.btcSats != null ? { btcSats: p.btcSats, qbtSats: p.qbtSats } : null;
    this.recovery = p.recovery || null;
    return this;
  }

  // ── create / join ────────────────────────────────────────────────────────────
  // `role` is the creator's OWN role: "alice" if the creator is BUYING QBT (initiator, sends BTC),
  // "bob" if SELLING QBT (participant, sends QBT). Only the initiator holds the secret; the invite link
  // hands the counterparty the other token. Every swap is btc2qbt under the hood.
  async create({ role = "alice", btcSats, qbtSats, securityLevel = "high", btcDest, qbitDest }) {
    this.role = role; this.direction = "btc2qbt"; this.btcDest = btcDest; this.qbitDest = qbitDest;
    this.terms = { btcSats, qbtSats };
    await this.#freshKeys(role === "alice");
    const { id, tokens } = await this.#api("/swaps", { method: "POST", body: { btcSats, qbtSats, securityLevel } });
    this.id = id; this.token = tokens[role];
    await this.#submit();
    const inviteToken = tokens[role === "alice" ? "bob" : "alice"];
    return { id, myToken: this.token, inviteToken, inviteLink: this.link(inviteToken) };
  }
  // Join from an invite link. We learn our role from the coordinator via our token — if we're the
  // initiator (alice, the QBT buyer) we must generate the secret + submit H; the participant must not.
  async join({ id, token, btcDest, qbitDest }) {
    this.id = id; this.token = token; this.btcDest = btcDest; this.qbitDest = qbitDest;
    const pre = await this.#api(`/swaps/${id}`, { token });
    this.role = pre.role; this.direction = pre.direction || "btc2qbt";
    await this.#freshKeys(this.role === "alice");
    const v = await this.#submit();
    this.terms = { btcSats: v.terms?.btcSats, qbtSats: v.terms?.qbtSats };
    return { id, role: this.role, direction: this.direction };
  }
  // Enter an already-created swap (e.g. one instantiated by taking an order-book offer) in a given role.
  async enter({ id, token, direction, role, btcDest, qbitDest }) {
    this.role = role; this.direction = direction; this.id = id; this.token = token; this.btcDest = btcDest; this.qbitDest = qbitDest;
    await this.#freshKeys(role === "alice");
    const v = await this.#submit();
    this.terms = { btcSats: v.terms?.btcSats, qbtSats: v.terms?.qbtSats };
    return { id };
  }
  #submit() {
    const body = { qbitPub: hex(this.qbit.pk), btcPub: hex(compressedPub(this.btcPriv)), btcDest: this.btcDest, qbitDest: this.qbitDest };
    if (this.role === "alice") body.H = hex(this.H);
    return this.#api(`/swaps/${this.id}/party`, { token: this.token, method: "POST", body });
  }
  link(inviteToken) {
    const l = globalThis.location;
    const lang = l?.search ? new URLSearchParams(l.search).get("lang") : null;   // carry the sharer's language into the invite link
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : "";
    return `${l?.origin || ""}${l?.pathname || ""}${q}#coord=${encodeURIComponent(this.base)}&id=${this.id}&token=${inviteToken}`;
  }

  // ── live drive ────────────────────────────────────────────────────────────────
  start() {
    const url = `${this.base}/swaps/${this.id}/events?token=${this.token}`;
    if (typeof EventSource !== "undefined") { this.es = new EventSource(url); this.es.onmessage = (e) => this.#onView(JSON.parse(e.data)); this.es.onerror = () => {}; }
    else this.timer = setInterval(async () => { try { this.#onView(await this.#api(`/swaps/${this.id}`, { token: this.token })); } catch {} }, 2000);
  }
  stop() { this.es?.close(); clearInterval(this.timer); }
  // Cancel an unfunded swap (either party). The coordinator rejects it once a deposit exists.
  cancel() { return this.#api(`/swaps/${this.id}/cancel`, { token: this.token, method: "POST" }); }

  async #onView(v) {
    this.view = v;
    // Independently re-derive the HTLC scripts from OUR keys + the counterparty pubkey + H + locktimes
    // and confirm they match the coordinator's. If not, a derivation bug or tampering produced a script
    // we don't control — HALT before any funds move.
    if (v.htlc && !this.verifyHtlc(v)) { this.halted = true; this.onUpdate({ ...v, securityError: true }); return; }
    this.onUpdate(v);
    if (this.halted) return;
    try { await this.#act(v); } catch (e) { this.onUpdate({ ...v, actionError: String(e.message || e) }); }
    if (v.state === "COMPLETE" || v.state === "REFUNDED" || v.state === "CANCELED") this.stop();
  }
  // Recompute both HTLC scriptPubKeys the way the coordinator must have, using our own real keys — a
  // mismatch means the address we'd fund isn't the script we can claim/refund. (This binds our keys, H,
  // and the locktimes into the scripts; it does not by itself authenticate the counterparty's pubkey.)
  verifyHtlc(v) {
    try {
      if (!v.roles || !v.locktimes || !v.counterparty?.qbitPub || !v.counterparty?.btcPub || !v.H) return true;   // not enough yet
      const H = bin(v.H), { fromLeg, toLeg } = v.roles;
      const self = { qbit: this.qbit.pk, btc: compressedPub(this.btcPriv) };
      const cp = { qbit: bin(v.counterparty.qbitPub), btc: bin(v.counterparty.btcPub) };
      const pk = (role, coin) => (role === this.role ? self[coin] : cp[coin]);
      const spk = (leg, claimRole, refundRole) => leg === "qbit"
        ? hex(p2mrSpk(htlcLeafQbit(H, pk(claimRole, "qbit"), pk(refundRole, "qbit"), v.locktimes.qbit)))
        : hex(p2wshSpk(htlcWitnessScript(H, pk(claimRole, "btc"), pk(refundRole, "btc"), v.locktimes.btc)));
      // deriveHtlcs: fromLeg claim=participant(bob)/refund=initiator(alice); toLeg claim=alice/refund=bob
      return spk(fromLeg, "bob", "alice") === v.htlc[fromLeg].spk && spk(toLeg, "alice", "bob") === v.htlc[toLeg].spk;
    } catch { return false; }
  }

  // Which leg this party funds / claims / refunds, from the swap's role map.
  legs(v) {
    const { fromLeg, toLeg } = v.roles;
    return this.role === "alice"
      ? { fund: fromLeg, claim: toLeg, refund: fromLeg }     // initiator
      : { fund: toLeg, claim: fromLeg, refund: toLeg };      // participant
  }

  async #act(v) {
    if (!v.htlc) return;
    // Arm the coordinator watchtower once BOTH legs are funded: pre-sign a fee-ladder claim + a refund
    // so the swap completes/refunds even if this tab closes. Non-custodial — pays only our addresses.
    if (v.funding?.btc && v.funding?.qbit) { try { await this.armSafetyNet(v); } catch { /* retry next tick */ } }

    const done = (k) => this.acted.has(k) || v.broadcasts?.[k];
    const { claim, refund } = this.legs(v);
    if (this.role === "alice") {
      if (v.state === "CLAIMABLE" && !done(`${claim}:claim`)) return this.#claim(v, claim, this.secret);
      if (v.refund?.[refund]?.available && v.state !== "COMPLETE" && !done(`${refund}:refund`)) return this.#refund(v, refund);
    } else {
      if (v.preimage && !done(`${claim}:claim`)) return this.#claim(v, claim, bin(v.preimage));
      if (v.refund?.[refund]?.available && !v.preimage && !done(`${refund}:refund`)) return this.#refund(v, refund);
    }
  }
  // Broadcast a signed claim/refund. Primary path is the coordinator (it relays to both chains' nodes
  // and updates its view). If the coordinator is unreachable, the BTC leg can still be pushed to the
  // network directly via public broadcast APIs — so a backend outage never traps your Bitcoin
  // claim/refund while this tab is open. (QBT has no public node; only the coordinator can relay it.)
  async #send(leg, kind, tx) {
    const key = `${leg}:${kind}`, txHex = hex(tx);
    this.acted.add(key);   // guard against a duplicate fire on the next tick while this send is in flight
    try {
      return await this.#api(`/swaps/${this.id}/broadcast`, { token: this.token, method: "POST", body: { leg, kind, tx: txHex } });
    } catch (e) {
      if (leg === "btc" && this.btcBroadcast.length) {
        try {
          const txid = await this.#broadcastDirect(txHex);
          this.onUpdate({ ...this.view, broadcastFallback: { leg, kind, txid } });   // surface that we bypassed the coordinator
          return { fallback: true, txid };
        } catch (fe) { this.acted.delete(key); throw fe; }
      }
      this.acted.delete(key);   // total failure — let #act retry this leg on the next update
      throw e;
    }
  }
  #broadcastDirect(txHex) { return postRawTx(this.btcBroadcast, txHex); }

  // ── watchtower safety net: pre-sign and upload a fee-ladder claim + a refund ──
  async armSafetyNet(v) {
    if (!v.htlc || !v.funding?.btc || !v.funding?.qbit) return;
    // Arm as soon as both deposits exist — even at 0-conf: the outpoints are known, so the recovery
    // txs can be pre-signed now. Re-key if a deposit is RBF-replaced (new outpoint) before it confirms,
    // so the stored bundle always references the live outpoints.
    const key = `${v.funding.btc.txid}:${v.funding.btc.vout}|${v.funding.qbit.txid}:${v.funding.qbit.vout}`;
    if (this.armedKey === key) return;
    const { claim, refund } = this.legs(v);
    // participant signs the claim preimage-LESS (the coordinator splices the preimage in on reveal).
    const claimPreimage = this.role === "alice" ? this.secret : new Uint8Array(0);
    // skip any tier whose fee would leave a dust/negative output (defensive; createSwap already floors amounts)
    const amount = v.funding[claim].amountSats;
    const affordable = LADDER[claim].map((fr) => ({ fr, fee: feeFor(claim, "claim", fr, v.feerates) })).filter(({ fee }) => amount - fee > DUST);
    const tiers = await Promise.all((affordable.length ? affordable : [{ fr: LADDER[claim][0], fee: feeFor(claim, "claim", LADDER[claim][0], v.feerates) }]).map(async ({ fr, fee }) =>
      ({ feerate: fr, tx: hex(await this.#build(v, claim, "claim", claimPreimage, fee)) })));
    const refundFeerate = LADDER[refund][Math.floor(LADDER[refund].length / 2)];
    const refundTx = hex(await this.#build(v, refund, "refund", new Uint8Array(0), feeFor(refund, "refund", refundFeerate, v.feerates)));
    const bundle = {
      claim: { leg: claim, needsPreimage: this.role !== "alice", tiers },
      refund: { leg: refund, tx: refundTx },
    };
    await this.#api(`/swaps/${this.id}/finish`, { token: this.token, method: "POST", body: bundle });
    // Keep our own copy of the pre-signed recovery ladder so it can be written into the backup file —
    // the file alone (keys + these txs) is enough to recover even if the coordinator is gone.
    this.recovery = bundle;
    this.armedKey = key;
    this.armed = true;   // the coordinator now reflects safetyNet.self=true in the view
  }

  // ── signing (leg-generic; build a tx at a given fee, then optionally broadcast) ──
  #build(v, leg, kind, preimage, feeSats) { return leg === "qbit" ? this.#buildQbit(v, kind, preimage, feeSats) : this.#buildBtc(v, kind, preimage, feeSats); }
  // Live claim/refund the party signs itself: size the BTC fee at mempool's High-priority tier
  // (v.feerates.fastestFee) so it confirms promptly — the pre-signed fee ladder is only the fallback
  // the watchtower uses when this party is OFFLINE. Never let the fee eat the output below dust.
  #liveFee(v, leg, kind) { const amt = v.funding?.[leg]?.amountSats || 0; return Math.min(dynFee(leg, kind, v.feerates), amt - DUST); }
  async #claim(v, leg, preimage) { return this.#send(leg, "claim", await this.#build(v, leg, "claim", preimage, this.#liveFee(v, leg, "claim"))); }
  async #refund(v, leg) { return this.#send(leg, "refund", await this.#build(v, leg, "refund", new Uint8Array(0), this.#liveFee(v, leg, "refund"))); }

  // Build (but do NOT broadcast) this party's claim or refund sweep at the current view — the same tx
  // #claim/#refund would send. Exposed for tests/tooling (e.g. checking timelock maturity). A refund's
  // nLockTime is the leg's CLTV height, so it is consensus-invalid ("non-final") until the chain reaches
  // it; a claim carries no timelock. Returns { leg, hex }.
  async buildSweep(v, kind) {
    const { claim, refund } = this.legs(v);
    const leg = kind === "refund" ? refund : claim;
    const preimage = kind === "refund" ? new Uint8Array(0) : (this.role === "alice" ? this.secret : bin(v.preimage));
    return { leg, hex: hex(await this.#build(v, leg, kind, preimage, this.#liveFee(v, leg, kind))) };
  }

  async #buildQbit(v, kind, preimage, feeSats) {
    const f = v.funding.qbit, leaf = bin(v.htlc.qbit.leaf), spk = bin(v.htlc.qbit.spk);
    const destSpk = addressToScriptPubKey(this.qbitDest), prevoutLE = bin(f.txid).reverse(), outVal = f.amountSats - feeSats;
    const refund = kind === "refund", lock = refund ? v.locktimes.qbit : 0, seq = refund ? 0xfffffffe : 0xffffffff;
    const sh = p2mrSighash({ version: 2, locktime: lock, vin: [{ txidLE: prevoutLE, vout: f.vout, sequence: seq }], spentOutputs: [{ amount: f.amountSats, spk }], vout: [{ value: outVal, spk: destSpk }], inputIndex: 0, leafScript: leaf });
    const sig = await slhDsaSign(this.qbit.sk, sh);
    const witIf = refund ? new Uint8Array(0) : preimage;           // ELSE(refund)=empty ; IF(claim)=preimage (empty placeholder when pre-signing preimage-less)
    const wit = refund ? [sig, witIf, leaf, P2MR_CONTROL_SINGLE_LEAF] : [sig, witIf, Uint8Array.of(0x01), leaf, P2MR_CONTROL_SINGLE_LEAF];
    return serializeTx({ version: 2, vin: [[prevoutLE, f.vout, new Uint8Array(0), seq]], vout: [[BigInt(outVal), destSpk]], wit: [wit], locktime: lock });
  }
  async #buildBtc(v, kind, preimage, feeSats) {
    const f = v.funding.btc, ws = bin(v.htlc.btc.witnessScript), destSpk = addressToScriptPubKey(this.btcDest);
    const branch = kind === "refund" ? "refund" : "claim";
    return btcSpend({ prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: this.btcPriv, destSpk, outVal: f.amountSats - feeSats, branch, preimage, locktime: branch === "refund" ? v.locktimes.btc : 0 });
  }
}

// Fixed fee ladders (sat/vB) the client pre-signs for the WATCHTOWER fallback; the coordinator
// picks/escalates tiers using live feerates when it must act for an offline party. BTC spans
// economy→extreme; Qbit is uncongested so a low pair suffices.
const DUST = 546;
// Public BTC broadcast endpoints for the coordinator-down fallback (#send), keyed by the BTC hrp
// (network). They accept a raw tx hex as the POST body and return the txid. Qbit has no equivalent
// public node, so there is no QBT fallback. Regtest ("bcrt") has no public endpoint → empty (disabled).
export const BTC_BROADCAST = {
  bc: ["https://mempool.space/api/tx", "https://blockstream.info/api/tx"],
  tb: ["https://mempool.space/testnet4/api/tx", "https://blockstream.info/testnet/api/tx"],
};
// POST a raw tx hex to each endpoint in turn; return the first accepted txid, or throw if none accept.
// Injectable fetch for testing. Used by the coordinator-down BTC broadcast fallback.
export async function postRawTx(endpoints, txHex, fetchImpl = fetch) {
  let lastErr;
  for (const url of endpoints) {
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "text/plain" }, body: txHex });
      const body = (await r.text()).trim();
      if (r.ok) return body;                                   // the txid
      lastErr = new Error(`${url} -> ${r.status} ${body.slice(0, 100)}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no reachable broadcast endpoint");
}
const LADDER = { btc: [2, 8, 25, 75, 200], qbit: [1, 5] };
// vsize per sweep (measured on regtest). IMPORTANT: Qbit's SLH-DSA witness gets NO segwit discount
// (vsize == weight ≈ 3.9k vB), so these must be the real sizes — a low estimate underpays the feerate
// and the tx can stall. Slightly conservative (real: qbit ~3900, btc refund ~130) so a floored fee
// still clears relay.
const VBYTES = { btc: { claim: 165, refund: 140 }, qbit: { claim: 4200, refund: 4200 } };
// Absolute fee floor (sats): never pay below the node's own min-relay feerate for this tx's size
// (`feerates.<leg>.minimumFee` — BTC from mempool.space, Qbit from getmempoolinfo). No hardcoded floor.
const relayFloor = (leg, kind, feerates) => Math.ceil(Math.max(1, feerates?.[leg]?.minimumFee || 1) * VBYTES[leg][kind]);
const feeFor = (leg, kind, feerate, feerates) => Math.max(relayFloor(leg, kind, feerates), Math.round(feerate * VBYTES[leg][kind]));
// The fee (sats) for a live-signed claim/refund, sized from the coordinator's per-chain recommendation
// (`view.feerates = { btc, qbit }`): High priority (fastestFee) for the urgent claim, Medium
// (halfHourFee) for the timelock-gated refund. BTC comes from mempool.space; Qbit from the node's own
// estimatesmartfee. This is the NORMAL path; the pre-signed ladder is only for extreme situations (a
// party offline during a fee spike).
export function dynFee(leg, kind, feerates) {
  const tier = kind === "claim" ? "fastestFee" : "halfHourFee";
  const fr = Math.max(1, feerates?.[leg]?.[tier] || 0);
  return Math.max(relayFloor(leg, kind, feerates), Math.round(fr * VBYTES[leg][kind]));
}
