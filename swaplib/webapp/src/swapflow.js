// Browser-side swap party, BIDIRECTIONAL. Generates ephemeral per-swap keys, creates/joins a swap
// through the coordinator's API, subscribes to its live feed, and signs its own claim/refund in-page
// (WASM SLH-DSA for the Qbit leg, ECDSA for the Bitcoin leg). The coordinator is keyless.
//
//   The CREATOR is the initiator (holds the secret): funds fromLeg (longer timelock), claims toLeg
//   (revealing the preimage). The joiner is the participant: funds toLeg, claims fromLeg with the
//   now-public preimage. `direction` ("btc2qbt"|"qbt2btc") sets which coin the initiator sends.
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
  constructor({ coordinator, onUpdate = () => {}, feeSats = { qbit: 100000, btc: 5000 } }) {
    this.base = coordinator.replace(/\/$/, "");
    this.onUpdate = onUpdate;
    this.feeSats = feeSats;
    this.acted = new Set();
  }

  async #api(path, { token, method = "GET", body } = {}) {
    const r = await fetch(this.base + path, { method, headers: { "content-type": "application/json", ...(token ? { "x-swap-token": token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
  }

  // ── identity / persistence ───────────────────────────────────────────────────
  async #freshKeys(isCreator) {
    this.qbit = await slhDsaKeygen(rand(128));
    this.btcPriv = rand(32);
    if (isCreator) { this.secret = rand(32); this.H = sha256(this.secret); }
  }
  secrets() {
    return {
      swapId: this.id, role: this.role, direction: this.direction, token: this.token, coordinator: this.base,
      btcDest: this.btcDest, qbitDest: this.qbitDest,
      qbitPk: hex(this.qbit.pk), qbitSk: hex(this.qbit.sk), btcPriv: hex(this.btcPriv),
      secret: this.secret ? hex(this.secret) : null, H: this.H ? hex(this.H) : null,
    };
  }
  restore(p) {
    this.id = p.swapId; this.role = p.role; this.direction = p.direction; this.token = p.token; this.base = p.coordinator.replace(/\/$/, "");
    this.btcDest = p.btcDest; this.qbitDest = p.qbitDest;
    this.qbit = { pk: bin(p.qbitPk), sk: bin(p.qbitSk) }; this.btcPriv = bin(p.btcPriv);
    this.secret = p.secret ? bin(p.secret) : null; this.H = p.H ? bin(p.H) : null;
    return this;
  }

  // ── create (initiator) / join (participant) ──────────────────────────────────
  async create({ direction = "btc2qbt", btcSats, qbtSats, securityLevel = "high", btcDest, qbitDest }) {
    this.role = "alice"; this.direction = direction; this.btcDest = btcDest; this.qbitDest = qbitDest;
    await this.#freshKeys(true);
    const { id, tokens } = await this.#api("/swaps", { method: "POST", body: { direction, btcSats, qbtSats, securityLevel } });
    this.id = id; this.token = tokens.alice;
    await this.#submit();
    return { id, aliceToken: tokens.alice, bobToken: tokens.bob, bobLink: this.link(tokens.bob) };
  }
  async join({ id, token, btcDest, qbitDest }) {
    this.role = "bob"; this.id = id; this.token = token; this.btcDest = btcDest; this.qbitDest = qbitDest;
    await this.#freshKeys(false);
    const v = await this.#submit();
    this.direction = v.direction;
    return { id, direction: v.direction };
  }
  // Enter an already-created swap (e.g. one instantiated by taking an order-book offer) in a given role.
  async enter({ id, token, direction, role, btcDest, qbitDest }) {
    this.role = role; this.direction = direction; this.id = id; this.token = token; this.btcDest = btcDest; this.qbitDest = qbitDest;
    await this.#freshKeys(role === "alice");
    await this.#submit();
    return { id };
  }
  #submit() {
    const body = { qbitPub: hex(this.qbit.pk), btcPub: hex(compressedPub(this.btcPriv)), btcDest: this.btcDest, qbitDest: this.qbitDest };
    if (this.role === "alice") body.H = hex(this.H);
    return this.#api(`/swaps/${this.id}/party`, { token: this.token, method: "POST", body });
  }
  link(bobToken) { const l = globalThis.location; return `${l?.origin || ""}${l?.pathname || ""}#coord=${encodeURIComponent(this.base)}&id=${this.id}&token=${bobToken}`; }

  // ── live drive ────────────────────────────────────────────────────────────────
  start() {
    const url = `${this.base}/swaps/${this.id}/events?token=${this.token}`;
    if (typeof EventSource !== "undefined") { this.es = new EventSource(url); this.es.onmessage = (e) => this.#onView(JSON.parse(e.data)); this.es.onerror = () => {}; }
    else this.timer = setInterval(async () => { try { this.#onView(await this.#api(`/swaps/${this.id}`, { token: this.token })); } catch {} }, 2000);
  }
  stop() { this.es?.close(); clearInterval(this.timer); }

  async #onView(v) {
    this.view = v;
    // Independently re-derive the HTLC scripts from OUR keys + the counterparty pubkey + H + locktimes
    // and confirm they match the coordinator's. If not, a derivation bug or tampering produced a script
    // we don't control — HALT before any funds move.
    if (v.htlc && !this.verifyHtlc(v)) { this.halted = true; this.onUpdate({ ...v, securityError: true }); return; }
    this.onUpdate(v);
    if (this.halted) return;
    try { await this.#act(v); } catch (e) { this.onUpdate({ ...v, actionError: String(e.message || e) }); }
    if (v.state === "COMPLETE" || v.state === "REFUNDED") this.stop();
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
    if (!this.armed && v.funding?.btc && v.funding?.qbit) { try { await this.armSafetyNet(v); } catch { /* retry next tick */ } }

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
  #send(leg, kind, tx) { this.acted.add(`${leg}:${kind}`); return this.#api(`/swaps/${this.id}/broadcast`, { token: this.token, method: "POST", body: { leg, kind, tx: hex(tx) } }); }

  // ── watchtower safety net: pre-sign and upload a fee-ladder claim + a refund ──
  async armSafetyNet(v) {
    if (this.armed || !v.htlc || !v.funding?.btc || !v.funding?.qbit) return;
    const { claim, refund } = this.legs(v);
    // participant signs the claim preimage-LESS (the coordinator splices the preimage in on reveal).
    const claimPreimage = this.role === "alice" ? this.secret : new Uint8Array(0);
    // skip any tier whose fee would leave a dust/negative output (defensive; createSwap already floors amounts)
    const amount = v.funding[claim].amountSats;
    const affordable = LADDER[claim].map((fr) => ({ fr, fee: feeFor(claim, "claim", fr) })).filter(({ fee }) => amount - fee > DUST);
    const tiers = await Promise.all((affordable.length ? affordable : [{ fr: LADDER[claim][0], fee: feeFor(claim, "claim", LADDER[claim][0]) }]).map(async ({ fr, fee }) =>
      ({ feerate: fr, tx: hex(await this.#build(v, claim, "claim", claimPreimage, fee)) })));
    const refundFeerate = LADDER[refund][Math.floor(LADDER[refund].length / 2)];
    const refundTx = hex(await this.#build(v, refund, "refund", new Uint8Array(0), feeFor(refund, "refund", refundFeerate)));
    await this.#api(`/swaps/${this.id}/finish`, { token: this.token, method: "POST", body: {
      claim: { leg: claim, needsPreimage: this.role !== "alice", tiers },
      refund: { leg: refund, tx: refundTx },
    } });
    this.armed = true;   // the coordinator now reflects safetyNet.self=true in the view
  }

  // ── signing (leg-generic; build a tx at a given fee, then optionally broadcast) ──
  #build(v, leg, kind, preimage, feeSats) { return leg === "qbit" ? this.#buildQbit(v, kind, preimage, feeSats) : this.#buildBtc(v, kind, preimage, feeSats); }
  async #claim(v, leg, preimage) { return this.#send(leg, "claim", await this.#build(v, leg, "claim", preimage, this.feeSats[leg])); }
  async #refund(v, leg) { return this.#send(leg, "refund", await this.#build(v, leg, "refund", new Uint8Array(0), this.feeSats[leg])); }

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

// Fixed fee ladders (sat/vB) the client pre-signs; the coordinator picks/escalates tiers using live
// mempool.space feerates. BTC spans economy→extreme; Qbit is uncongested so a low pair suffices.
const DUST = 546;
const LADDER = { btc: [2, 8, 25, 75, 200], qbit: [1, 5] };
const VBYTES = { btc: { claim: 150, refund: 120 }, qbit: { claim: 1000, refund: 1000 } };   // rough (SLH-DSA witness dominates the qbit legs)
const FEE_FLOOR = { btc: 400, qbit: 8000 };
const feeFor = (leg, kind, feerate) => Math.max(FEE_FLOOR[leg], Math.round(feerate * VBYTES[leg][kind]));
