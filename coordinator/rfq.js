// RFQ liquidity layer: authorized market-maker BOTS stream two-sided quotes; retail gets a one-click
// price aggregated across them. Distinct from offers.js (the public peer order book of one-lot offers):
// an RFQ quote is a STANDING price with size that must be actively re-pinged — if a bot stops pinging,
// its liquidity drops out after RFQ_TTL_MS, so the widget can never quote from a dead maker. Taking a
// quote instantiates a normal keyless swap (same engine, same safety flow); the maker learns about the
// match in its next ping response and joins/fulfills through the ordinary per-swap API.
//
// Makers are configured (not open-registration): RFQ_MAKER_KEYS="name:key,name2:key2". The whole layer
// is OFF unless at least one key is set. Prices are BTC per QBT (same orientation as offers.js);
// sizes are qbtSats. bid = maker buys QBT (retail SELLS into it), ask = maker sells QBT (retail BUYS).
//
// Roles follow the engine's fixed rule (QBT buyer = alice/initiator): retail buy → taker=alice,
// maker=bob; retail sell → maker=alice, taker=bob.
import { createHash, randomBytes } from "node:crypto";
import { createSwap, getSwap, MIN_SATS, feeTotalOn, takerNetOfGross } from "./swap.js";

export const RFQ_TTL_MS = Number(process.env.RFQ_TTL_MS || 30000);          // quote lifetime per ping
const MATCH_RETENTION_MS = Number(process.env.RFQ_MATCH_RETENTION_MS || 86400000);   // stop re-delivering ancient matches
const DONE = ["CANCELED", "COMPLETE", "REFUNDED", "ABORTED"];

// ── reputation / fill-rate ──────────────────────────────────────────────────────────────────────
// A maker that gets matched but doesn't fund its leg leaves a taker stranded (on a buy the taker already
// deposited BTC first and must wait out a timelock). We can't lock a maker's funds, so instead we watch
// what it actually DOES: of the matches where the maker was cleared to fund, how often did it? A maker
// that no-shows repeatedly in a rolling window is auto-suspended (its quotes stop being served) until the
// bad marks age out — cheap, permissionless-friendly, and it punishes the real failure (not funding),
// not a proxy for it. Attribution is fault-aware: a taker who never funds their own first leg is NOT
// counted against the maker (on a buy the maker legitimately can't fund until the taker's BTC buries).
const REP_GRACE_MS = Number(process.env.RFQ_REP_GRACE_MS || 900000);     // 15m after it's cleared to fund → a still-unfunded match is a no-show
const REP_WINDOW_MS = Number(process.env.RFQ_REP_WINDOW_MS || 3600000);  // rolling window for the suspension count
const REP_SUSPEND = Number(process.env.RFQ_REP_SUSPEND || 3);            // this many no-shows in the window → suspended (0 disables)
const REP_HISTORY = Number(process.env.RFQ_REP_HISTORY || 500);          // cap the per-maker match log

// makers: name -> { name, keyHash, quote: { bid|null, ask|null, at } | null, matches: [] }
// Keys are never stored in cleartext (env-only secret); auth compares sha256 digests, which also makes
// the comparison fixed-length (no length oracle).
const makers = new Map();
const keyHash = (k) => createHash("sha256").update(String(k)).digest("hex");
for (const pair of (process.env.RFQ_MAKER_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const i = pair.indexOf(":");
  if (i <= 0 || i === pair.length - 1) throw new Error(`RFQ_MAKER_KEYS entry must be name:key — got "${pair}"`);
  const name = pair.slice(0, i);
  if (makers.has(name)) throw new Error(`RFQ_MAKER_KEYS: duplicate maker name "${name}"`);
  makers.set(name, { name, keyHash: keyHash(pair.slice(i + 1)), quote: null, matches: [], history: [] });
}

export const rfqEnabled = () => makers.size > 0;
export function makerByKey(key) {
  if (!key) return null;
  const h = keyHash(key);
  for (const m of makers.values()) if (m.keyHash === h) return m;
  return null;
}

const now = () => Date.now();
const live = (m) => !!m.quote && now() - m.quote.at < RFQ_TTL_MS;

// One side of a quote: { price (BTC per QBT, > 0), qbtSats (max size at that price) }.
function normSide(v, label) {
  if (v == null) return null;                               // absent or explicit null → no quote on this side
  const price = Number(v.price), qbtSats = Math.floor(Number(v.qbtSats));
  if (!(price > 0) || !isFinite(price)) throw new Error(`${label}.price must be > 0 (BTC per QBT)`);
  if (!(qbtSats > 0)) throw new Error(`${label}.qbtSats must be > 0`);
  return { price, qbtSats };
}
// The maker's ping: restate (or update) the quote and refresh the TTL. Field semantics: a side that is
// PRESENT (object or null) replaces that side; an ABSENT side carries the previous value forward — so a
// bare {} ping is a pure keep-alive. Sizes are absolute (remaining size is overwritten by each ping; the
// maker accounts for its own pending matches, which it sees in the same response).
export function submitQuote(m, body = {}) {
  const prev = m.quote || { bid: null, ask: null };
  m.quote = {
    bid: "bid" in body ? normSide(body.bid, "bid") : prev.bid,
    ask: "ask" in body ? normSide(body.ask, "ask") : prev.ask,
    at: now(),
  };
  return m.quote;
}

// Matches still awaiting this maker: delivered in EVERY ping until the maker joins the swap (submits
// its party data) or the swap dies — idempotent, so a bot needs no ack protocol. Old/dead ones prune.
export function pendingMatches(m) {
  const t = now();
  m.matches = m.matches.filter((x) => t - x.at < MATCH_RETENTION_MS && !DONE.includes(getSwap(x.swapId)?.state ?? "CANCELED"));
  return m.matches.filter((x) => !getSwap(x.swapId)?.party?.[x.role]);
}

// ── retail pricing ────────────────────────────────────────────────────────────
// side: "buy" = retail buys QBT (lifts maker asks, best = LOWEST price)
//       "sell" = retail sells QBT (hits maker bids, best = HIGHEST price)
// Amount is given on either leg; the other is derived from the maker's price, always rounded in the
// MAKER's favor (a sat of rounding must never let retail extract size the maker didn't quote).
//
// Fee incidence — TAKER-pays on RFQ (peer link swaps keep their buyer-pays structure):
//   buy:  the taker is the BTC sender, so the engine's normal gross-up (terms + fee on top) already
//         charges the taker; the maker receives terms.btcSats in full. Nothing to adjust here.
//   sell: the maker is the BTC sender, so we quote the taker's proceeds NET of the fee —
//         btcSats = takerNetOfGross(size × bid) — which makes the maker's all-in outlay
//         (terms.btcSats + fee gross-up) exactly its quoted price, and the fee lands on the taker.
const sideKey = (side) => (side === "buy" ? "ask" : "bid");
function derive(side, price, { btcSats, qbtSats }) {
  if (qbtSats > 0) {
    const q = Math.floor(qbtSats);
    return { qbtSats: q, btcSats: side === "buy" ? Math.ceil(q * price) : takerNetOfGross(Math.floor(q * price)) };
  }
  if (btcSats > 0) {
    const b = Math.floor(btcSats);   // buy: what the taker's BTC buys; sell: the NET proceeds the taker asked for (fee added back before sizing the QBT)
    return { btcSats: b, qbtSats: side === "buy" ? Math.floor(b / price) : Math.ceil((b + feeTotalOn(b)) / price) };
  }
  throw new Error("btcSats or qbtSats required");
}
// Classify one past match by what the maker did, fault-aware. Reads the live swap the match created.
//   completed    — swap settled COMPLETE (maker delivered, taker too)
//   funded       — maker funded its leg (swap in flight or ended non-complete for reasons past funding)
//   no-show      — maker was CLEARED to fund but didn't (terminal without its deposit, or grace elapsed)
//   waiting-taker/taker-abort — the TAKER never funded their first leg, so the maker couldn't act: NOT
//                  attributed to the maker (on a buy the maker's QBT can't be funded until the taker's
//                  BTC buries; a bid maker funds first, so it's always "cleared").
//   gone         — swap no longer in the store (unknown; ignored)
function classifyMatch(h) {
  const s = getSwap(h.swapId);
  if (!s) return "gone";
  const makerLeg = h.role === "alice" ? s.roles?.fromLeg : s.roles?.toLeg;   // the leg THIS maker funds
  if (s.state === "COMPLETE") return "completed";
  if (makerLeg && s.funding?.[makerLeg]) return "funded";
  const cleared = h.role === "alice" ? true : !!s.fromConfirmedAt;           // bid maker funds first (always cleared); ask maker only once the taker's BTC buries
  const terminal = DONE.includes(s.state);
  if (!cleared) return terminal ? "taker-abort" : "waiting-taker";           // taker's fault / still early — not the maker's
  if (terminal) return "no-show";                                            // cleared, ended, never funded
  const since = h.role === "alice" ? h.at : (s.fromConfirmedAt || h.at);
  return now() - since > REP_GRACE_MS ? "no-show" : "pending";               // cleared but still unfunded → grace decides
}
// Aggregate a maker's reputation from its match history + the live swaps those matches created.
export function makerRep(m) {
  const c = { completed: 0, funded: 0, "no-show": 0, pending: 0, "waiting-taker": 0, "taker-abort": 0, gone: 0 };
  let recentNoShow = 0;
  for (const h of m.history) {
    const k = classifyMatch(h);
    c[k]++;
    if (k === "no-show" && now() - h.at < REP_WINDOW_MS) recentNoShow++;
  }
  const delivered = c.completed + c.funded;                                  // maker did its leg
  const obligated = delivered + c["no-show"];                               // times it was cleared AND resolved
  const suspended = REP_SUSPEND > 0 && recentNoShow >= REP_SUSPEND;
  return {
    matched: m.history.length, completed: c.completed, funded: delivered, noShow: c["no-show"], pending: c.pending,
    notAttributed: c["waiting-taker"] + c["taker-abort"],
    fillRate: obligated ? delivered / obligated : null,                      // null = no attributable history yet
    recentNoShow, suspended,
  };
}
export const makerSuspended = (m) => makerRep(m).suspended;

function liveSides(side) {
  const k = sideKey(side);
  // A suspended maker (too many recent no-shows) is dropped from the book until its bad marks age out.
  return [...makers.values()].filter((m) => live(m) && !makerSuspended(m) && m.quote[k] && m.quote[k].qbtSats > 0).map((m) => ({ m, q: m.quote[k] }));
}
// Total size on a side + its best price — the widget's "liquidity available" line.
export function depth() {
  const agg = (side) => {
    const xs = liveSides(side);
    const prices = xs.map((x) => x.q.price);
    return { qbtSats: xs.reduce((n, x) => n + x.q.qbtSats, 0), price: prices.length ? (side === "buy" ? Math.min(...prices) : Math.max(...prices)) : null, makers: xs.length };
  };
  return { enabled: rfqEnabled(), ttlMs: RFQ_TTL_MS, minSats: MIN_SATS, buy: agg("buy"), sell: agg("sell") };
}

// Best single-maker fill for the requested size (a swap has exactly one counterparty, so no splitting
// across makers — v1 picks the best-priced maker whose remaining size covers the full amount).
export function bestQuote(side, amounts) {
  if (side !== "buy" && side !== "sell") throw new Error('side must be "buy" or "sell"');
  const candidates = liveSides(side)
    .map(({ m, q }) => ({ m, price: q.price, max: q.qbtSats, ...derive(side, q.price, amounts) }))
    .filter((c) => c.qbtSats > 0 && c.qbtSats <= c.max)
    .sort((a, b) => (side === "buy" ? a.price - b.price : b.price - a.price));
  if (!candidates.length) {
    const d = depth()[side];
    const e = new Error(d.qbtSats > 0 ? "not enough liquidity for this size" : "no liquidity right now");
    e.available = d.qbtSats;
    throw e;
  }
  const c = candidates[0];
  if (!(c.btcSats >= MIN_SATS.btc) || !(c.qbtSats >= MIN_SATS.qbit)) throw new Error(`amount too small (minimum ${MIN_SATS.btc / 1e8} BTC and ${MIN_SATS.qbit / 1e8} QBT)`);
  return { side, price: c.price, btcSats: c.btcSats, qbtSats: c.qbtSats, ttlMs: RFQ_TTL_MS, _maker: c.m };   // _maker stripped before serving
}
export const publicQuote = ({ _maker, ...q }) => q;

// Open ONE swap against one maker for a sized leg { price, btcSats, qbtSats }: create the swap,
// decrement the maker's remaining size, queue its match (delivered on its next ping) and log it for
// reputation. `orderId` tags legs of the same multi-maker fill so they can be tracked as one order.
function openLeg(m, side, leg, orderId) {
  const takerRole = side === "buy" ? "alice" : "bob";      // QBT buyer is always the initiator
  const makerRole = takerRole === "alice" ? "bob" : "alice";
  const swap = createSwap({ btcSats: leg.btcSats, qbtSats: leg.qbtSats, securityLevel: "high" });
  if (orderId) swap.orderId = orderId;
  m.quote[sideKey(side)].qbtSats = Math.max(0, m.quote[sideKey(side)].qbtSats - leg.qbtSats);
  const match = { swapId: swap.id, token: swap.tokens[makerRole], role: makerRole, side: sideKey(side), price: leg.price, btcSats: leg.btcSats, qbtSats: leg.qbtSats, at: now() };
  m.matches.push(match);
  m.history.push({ swapId: swap.id, role: makerRole, at: match.at });   // append-only reputation log (matches[] gets pruned; this doesn't)
  if (m.history.length > REP_HISTORY) m.history.shift();
  return { swapId: swap.id, token: swap.tokens[takerRole], role: takerRole, terms: swap.terms, price: leg.price };
}

// Take: re-price at the CURRENT best and fill only if it's no worse than the price the retail user was
// shown (limit semantics — a better price is fine, a worse one is a "price moved" reject so the UI can
// re-quote). Single-maker (one swap). See takeFill for the multi-maker version.
export function takeRfq({ side, btcSats, qbtSats, price }) {
  const lim = Number(price);
  if (!(lim > 0)) throw new Error("price (the quoted price you accepted) is required");
  const q = bestQuote(side, { btcSats: Number(btcSats) || 0, qbtSats: Number(qbtSats) || 0 });
  const worse = side === "buy" ? q.price > lim * (1 + 1e-9) : q.price < lim * (1 - 1e-9);
  if (worse) { const e = new Error("price moved — refresh the quote"); e.quote = publicQuote(q); throw e; }
  return openLeg(q._maker, side, { price: q.price, btcSats: q.btcSats, qbtSats: q.qbtSats });
}

// ── multi-maker routing ──────────────────────────────────────────────────────────────────────────
// Fill a size that no single maker covers by walking the book best-price-first and taking a slice from
// each until the request is met (or liquidity runs out → a partial plan). Suspended/expired makers are
// already excluded (liveSides). Each slice is sized in the maker's favor; a remainder too small to be
// its own swap (below MIN_SATS) is dropped rather than made into a dust swap. Returns the aggregate
// (VWAP price + totals) plus the per-leg breakdown. Nothing is created — this is the quote.
export function planFill(side, amounts) {
  if (side !== "buy" && side !== "sell") throw new Error('side must be "buy" or "sell"');
  const wantQbt = Math.floor(Number(amounts.qbtSats) || 0);
  const wantBtc = Math.floor(Number(amounts.btcSats) || 0);
  if (!(wantQbt > 0) && !(wantBtc > 0)) throw new Error("btcSats or qbtSats required");
  const ranked = liveSides(side).sort((a, b) => (side === "buy" ? a.q.price - b.q.price : b.q.price - a.q.price));   // best price first
  const legs = [];
  let gotQbt = 0, gotBtc = 0;
  for (const { m, q } of ranked) {
    if ((wantQbt && gotQbt >= wantQbt) || (wantBtc && gotBtc >= wantBtc)) break;
    let legQbt = q.qbtSats;                                                   // this maker's remaining size
    if (wantQbt) legQbt = Math.min(legQbt, wantQbt - gotQbt);
    if (wantBtc) legQbt = Math.min(legQbt, side === "buy" ? Math.floor((wantBtc - gotBtc) / q.price) : Math.ceil((wantBtc - gotBtc) / q.price));
    if (legQbt <= 0) continue;
    const d = derive(side, q.price, { qbtSats: legQbt });
    if (d.qbtSats < MIN_SATS.qbit || d.btcSats < MIN_SATS.btc) continue;      // sub-min remainder can't be its own swap
    legs.push({ m, price: q.price, qbtSats: d.qbtSats, btcSats: d.btcSats });
    gotQbt += d.qbtSats; gotBtc += d.btcSats;
  }
  return {
    side, legs, qbtSats: gotQbt, btcSats: gotBtc,
    price: gotQbt ? gotBtc / gotQbt : null,                                   // volume-weighted average, BTC per QBT
    requested: { qbtSats: wantQbt || null, btcSats: wantBtc || null },
    complete: wantQbt ? gotQbt >= wantQbt : gotBtc >= wantBtc,                // false = liquidity ran out (partial)
    makers: legs.length, ttlMs: RFQ_TTL_MS,
  };
}
export const publicPlan = (p) => ({ ...p, legs: p.legs.map(({ m, ...leg }) => leg) });   // strip maker identity

// Take a multi-maker fill: re-plan now, gate on the AGGREGATE (VWAP) limit price, then open one swap per
// leg under a shared orderId. Returns the order — one { swapId, token, role, terms } the taker drives per
// leg (independent swaps: any leg can complete or refund on its own → a partial fill is possible and
// reported via `complete`/totals). Each leg's maker learns of its match on its next ping.
export function takeFill({ side, btcSats, qbtSats, price }) {
  const lim = Number(price);
  if (!(lim > 0)) throw new Error("price (the quoted VWAP you accepted) is required");
  const plan = planFill(side, { btcSats: Number(btcSats) || 0, qbtSats: Number(qbtSats) || 0 });
  if (!plan.legs.length) { const d = depth()[side]; const e = new Error(d.qbtSats > 0 ? "not enough liquidity for this size" : "no liquidity right now"); e.available = d.qbtSats; throw e; }
  const worse = side === "buy" ? plan.price > lim * (1 + 1e-9) : plan.price < lim * (1 - 1e-9);
  if (worse) { const e = new Error("price moved — refresh the quote"); e.quote = publicPlan(plan); throw e; }
  const orderId = randomBytes(16).toString("hex");
  const legs = plan.legs.map((leg) => openLeg(leg.m, side, leg, orderId));
  return { orderId, side, price: plan.price, qbtSats: plan.qbtSats, btcSats: plan.btcSats, requested: plan.requested, complete: plan.complete, legs };
}

// Admin/monitoring projection — quote ages + pending-match counts per maker; never the key (only its
// hash exists) and never the per-swap tokens.
export function rfqStatus() {
  return {
    enabled: rfqEnabled(), ttlMs: RFQ_TTL_MS,
    makers: [...makers.values()].map((m) => ({
      name: m.name, live: live(m), suspended: makerSuspended(m), quoteAgeMs: m.quote ? now() - m.quote.at : null,
      bid: m.quote?.bid || null, ask: m.quote?.ask || null,
      pendingMatches: pendingMatches(m).length,
      reputation: makerRep(m),
    })),
  };
}
