// qbit-swap web app — a one-decision-per-screen wizard. Wallet-agnostic: the browser makes ephemeral
// per-swap keys, signs its own claim/refund, and talks to a keyless coordinator. Either side can
// initiate (the first screen picks the direction). Backup is a plaintext file (no password for now).
// UI strings are translated via i18n (English / 简体中文) with a header switcher.
import { SwapClient, dynFee } from "./swapflow.js";
import { exportBackup, importBackup, Vault } from "./keystore.js";
import { t, getLang, setLang, LANGS } from "./i18n.js";
import { addressToScriptPubKey, addressCoin } from "@qbit-swap/client";

// Expected network per coin (bech32 hrp). Regtest by default; a mainnet deploy injects
// window.QBIT_HRPS = { btc: "bc", qbit: "qb" } (testnet: "tb" / a qbit testnet hrp).
const HRPS = globalThis.QBIT_HRPS || { btc: "bcrt", qbit: "qbrt" };
const KNOWN_HRPS = ["bcrt", "bc", "tb", "sb", "qbrt", "qbt", "tqb", "qb"];
// Is `addr` on the specific network `expectedHrp`? bech32 by hrp; btc legacy base58 by mainnet-vs-test.
function addressOnNetwork(addr, expectedHrp) {
  const a = addr.trim(), l = a.toLowerCase(), sep = l.lastIndexOf("1");
  if (sep > 0) { const hrp = l.slice(0, sep); if (KNOWN_HRPS.includes(hrp)) return hrp === expectedHrp; }
  const mainnet = expectedHrp === "bc";                       // btc legacy: 1/3 = mainnet, m/n/2 = test/regtest
  if (/^[13]/.test(a)) return mainnet;
  if (/^[mn2]/.test(a)) return !mainnet;
  return false;
}
// Validate a receiving/refund address: non-empty, decodable, the right CHAIN (a BTC address where a QBT
// one is needed would send funds to an unspendable cross-chain output), and the right NETWORK (a testnet
// address on a mainnet swap would be unspendable by the intended wallet).
function validAddr(value, coin) {
  const a = (value || "").trim();
  if (!a) throw new Error(t("errEnterAddr", { coin }));
  const want = coin === "BTC" ? "btc" : "qbit";
  let ok = false;
  try { addressToScriptPubKey(a); ok = addressCoin(a) === want && addressOnNetwork(a, HRPS[want]); } catch { ok = false; }
  if (!ok) throw new Error(t("errBadAddr", { coin }));
  return a;
}

const DEFAULT_COORD = globalThis.QBIT_COORDINATOR || "http://127.0.0.1:8787";
const FAUCET = globalThis.QBIT_TRIAL_FAUCET || null;
const ORDERBOOK = globalThis.QBIT_ORDERBOOK === true;   // feature flag, default OFF — peer-to-peer only
const appEl = document.getElementById("app");
const vault = new Vault();
let rerender = () => init();     // re-invoked on language change to redraw the current screen
let liveGuard = { risky: false };   // true when funds are committed but the safety net isn't armed yet
// Warn before leaving if funds are locked but the watchtower isn't armed yet (nothing to finish for you).
window.addEventListener("beforeunload", (e) => { if (liveGuard.risky) { e.preventDefault(); e.returnValue = t("leaveWarn"); return t("leaveWarn"); } });

// ── coin / direction helpers ──────────────────────────────────────────────────
const DIR = { btc2qbt: { from: "BTC", to: "QBT" }, qbt2btc: { from: "QBT", to: "BTC" } };
const coinLeg = (coin) => (coin === "BTC" ? "btc" : "qbit");
const sats = (n) => (n / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
const toSats = (v) => Math.round(parseFloat(v) * 1e8);
const DUST_UI = 546;
// What the receiver nets after the network fee for CLAIMING the coin they receive. The claim is sized
// at mempool's High-priority feerate (same dynFee the client signs with), so this matches reality.
function netReceive(recv, feerates) {
  const gross = coinSats(recv);
  const fee = Math.min(dynFee(coinLeg(recv), "claim", feerates), Math.max(0, gross - DUST_UI));
  return { gross, fee, net: gross - fee };
}
const feeStr = (coin, fee) => (coin === "BTC" ? `${fee.toLocaleString()} sat` : `${sats(fee)} QBT`);
const shorten = (s, n = 10) => (s && s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const parseHash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));

// ── tiny DOM helper ───────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid?.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const render = (node) => { while (appEl.firstChild) appEl.removeChild(appEl.firstChild); appEl.append(node); };

function screen({ title, subtitle, body = [], cta, onCta, secondary, back }) {
  const btn = cta ? h("button", { class: "primary", style: "width:100%;margin-top:18px", onclick: async (e) => { const b = e.target; b.disabled = true; try { await onCta(); } catch (err) { b.disabled = false; alert(err.message); } } }, cta) : null;
  const backLink = back ? h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); back(); } }, t("back")) : null;
  const footer = (backLink || secondary) ? h("div", { style: "margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:12px" }, backLink || h("span"), secondary || h("span")) : null;
  return h("div", { class: "card" }, h("h2", {}, title), subtitle ? h("p", { class: "note", style: "margin-top:-4px" }, subtitle) : null, ...body, btn, footer);
}
const bigChoice = (glyph, label, sub, onClick) => h("button", { class: "choice", onclick: onClick },
  h("span", { class: "glyph" }, glyph),
  h("span", { class: "ct" }, h("b", {}, label), h("span", {}, sub)),
  h("span", { class: "arr", "aria-hidden": "true" }, "→"));
const field = (placeholder, value = "") => h("input", { placeholder, value });
// Copy button that flashes a "copied" label, then reverts after a moment.
function copyButton(labelKey, copiedKey, getText) {
  const btn = h("button", { class: "copy", onclick: () => {
    try { navigator.clipboard?.writeText(getText()); } catch {}
    btn.textContent = t(copiedKey);
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = t(labelKey); }, 2500);
  } }, t(labelKey));
  return btn;
}

// trial helper: pre-fill throwaway receive/refund addresses (funding is manual — the user sends).
async function faucetNewAddress(leg) { const r = await fetch(`${FAUCET}/newaddress?leg=${leg}`); return (await r.json()).address; }
async function prefill(input, coin) { if (!FAUCET) return; try { input.value = await faucetNewAddress(coinLeg(coin)); } catch {} }

// ── flow state ────────────────────────────────────────────────────────────────
const flow = { mode: null, direction: null, coordinator: DEFAULT_COORD, btcSats: 0, qbtSats: 0, receiveAddr: "", refundAddr: "", client: null, bobLink: null };
const coinSats = (coin) => (coin === "BTC" ? flow.btcSats : flow.qbtSats);
// initiator (create/take) sends `from`, receives `to`; participant (join) sends `to`, receives `from`.
const roleCoins = () => { const d = DIR[flow.direction]; return flow.mode === "join" ? { send: d.to, recv: d.from } : { send: d.from, recv: d.to }; };
// coordinator REST helpers (the order book lives outside the per-party SwapClient)
const coordUrl = (p) => `${DEFAULT_COORD}${p}`;
const coordGet = async (p) => { const r = await fetch(coordUrl(p)); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };
const coordPost = async (p, body) => { const r = await fetch(coordUrl(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };

// ── entry ─────────────────────────────────────────────────────────────────────
async function init() {
  rerender = () => init();
  const q = parseHash();
  if (q.coord && q.id && q.token) return startParticipant({ coordinator: decodeURIComponent(q.coord), id: q.id, token: q.token });
  const resumable = await vault.list().catch(() => []);
  render(h("div", {},
    screen({
      title: t("swapWhichWay"), subtitle: t("nonCustodial"),
      body: [
        bigChoice("₿", t("haveBtc"), t("haveBtcSub"), () => chooseDirection("btc2qbt")),
        bigChoice("Q", t("haveQbt"), t("haveQbtSub"), () => chooseDirection("qbt2btc")),
      ],
    }),
    await recoverCard(resumable),
  ));
}

function chooseDirection(direction) {
  flow.direction = direction;
  flow.btcSats = 100000000; flow.qbtSats = 500000000;
  if (ORDERBOOK) return showMarket(direction);   // order book (flagged); otherwise go straight to peer-to-peer
  flow.mode = "create"; stepConfirm();
}

// ── market view: the order-book side relevant to the chosen direction + a peer option ─────────
// btc->qbt = buy QBT (take asks); qbt->btc = sell QBT (take bids).
async function showMarket(direction) {
  rerender = () => showMarket(direction);
  const action = direction === "btc2qbt" ? "buy" : "sell";
  render(h("div", {},
    marketCard(direction, action, { asks: [], bids: [] }),
    h("div", { class: "card", style: "text-align:center" }, h("button", { class: "primary", style: "width:100%", onclick: () => startPeer() }, t("tradePeer")))));
  refreshMarket(direction, action);
  scheduleMarketRefresh(direction, action);
}
function marketCard(direction, action, book) {
  const offers = action === "buy" ? book.asks : book.bids;
  return h("div", { class: "card", id: "market" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:center" },
      h("h2", { style: "margin:0" }, action === "buy" ? t("buyQbt") : t("sellQbt")),
      h("button", { class: "copy", onclick: () => refreshMarket(direction, action) }, t("refreshBook"))),
    ...(offers && offers.length ? offers.map((o) => offerRow(o, action)) : [h("p", { class: "note", style: "margin-top:10px" }, t("noOffers"))]),
    h("div", { style: "margin-top:14px" }, h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); init(); } }, t("back"))));
}
async function refreshMarket(direction, action) {
  try { const book = await coordGet("/offers"); const el = document.getElementById("market"); if (el) el.replaceWith(marketCard(direction, action, book)); } catch {}
}
function scheduleMarketRefresh(direction, action) {
  clearInterval(window._bookTimer);
  window._bookTimer = setInterval(() => { if (!document.getElementById("market")) return clearInterval(window._bookTimer); refreshMarket(direction, action); }, 6000);
}
function offerRow(o, action) {
  const btn = h("button", { class: "primary", style: "padding:6px 16px", onclick: () => takeAndStart(o, action) }, action === "buy" ? t("buyBtn") : t("sellBtn"));
  return h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid var(--line)" },
    h("div", {}, h("span", { style: "font-weight:600" }, `${sats(o.qbtSats)} QBT`), h("span", { class: "note", style: "margin-left:10px" }, `${o.price.toFixed(4)} ${t("perQbt")}`)),
    h("div", { style: "display:flex;align-items:center;gap:14px" }, h("span", { class: "note" }, `${sats(o.btcSats)} BTC`), btn));
}
async function takeAndStart(o, action) {
  try {
    const take = await coordPost(`/offers/${o.id}/take`);       // { swapId, takerToken, direction, terms }
    clearInterval(window._bookTimer);
    flow.mode = "take"; flow.takeAction = action; flow.direction = take.direction;
    flow.btcSats = take.terms.btcSats; flow.qbtSats = take.terms.qbtSats;
    flow.takeSwapId = take.swapId; flow.takeToken = take.takerToken; flow.receiveAddr = ""; flow.refundAddr = "";
    stepTakeConfirm();
  } catch (e) { alert(e.message); refreshMarket(flow.direction, action); }   // e.g. someone else took it
}
function stepTakeConfirm() {
  rerender = stepTakeConfirm;
  const summary = flow.takeAction === "buy" ? t("buyingSummary", { qbt: sats(flow.qbtSats), btc: sats(flow.btcSats) }) : t("sellingSummary", { qbt: sats(flow.qbtSats), btc: sats(flow.btcSats) });
  render(screen({
    title: flow.takeAction === "buy" ? t("buyQbt") : t("sellQbt"),
    body: [h("div", { class: "fund" }, h("div", { style: "font-size:16px;font-weight:600" }, summary)), h("p", { class: "note" }, t("confirmP3"))],
    cta: t("continue"), onCta: () => stepReceive(),
    back: () => showMarket(flow.direction),
  }));
}
async function doTake() {
  flow.client = new SwapClient({ coordinator: flow.coordinator || DEFAULT_COORD });
  await flow.client.enter({ id: flow.takeSwapId, token: flow.takeToken, direction: flow.direction, role: "alice", ...destsForClient() });
  await vault.save(flow.client.secrets());
  stepBackup(() => startLive());
}
// Trade directly with a peer (create a private swap + share a link) for the chosen direction.
function startPeer() {
  clearInterval(window._bookTimer);
  flow.mode = "create";
  stepConfirm();
}

async function recoverCard(ids) {
  const card = h("div", { class: "card" }, h("h2", {}, t("recoverTitle")), h("p", { class: "note" }, t("recoverBody")));
  for (const id of ids) {
    const s = await vault.load(id);
    card.append(h("button", { class: "primary", style: "width:100%;margin-top:8px", onclick: () => resumeSwap(s) }, t("resumeBtn", { from: DIR[s.direction]?.from, to: DIR[s.direction]?.to, id: shorten(id, 6) })));
  }
  const fileInput = h("input", { type: "file", accept: "application/json", style: "display:none", onchange: async (e) => { const f = e.target.files?.[0]; if (!f) return; try { resumeSwap(importBackup(await f.text())); } catch (err) { alert(t("errReadBackup", { msg: err.message })); } } });
  card.append(fileInput, h("div", { class: "btns", style: "margin-top:10px" }, h("button", { onclick: () => fileInput.click() }, ids.length ? t("uploadInstead") : t("uploadBackup"))));
  return card;
}

function stepConfirm() {
  rerender = stepConfirm;
  const d = DIR[flow.direction];
  render(screen({
    title: t("beforeBegin"), subtitle: t("confirmSub"),
    body: [
      h("p", { class: "note" }, t("confirmP1", { from: d.from, to: d.to })),
      h("p", { class: "note" }, t("confirmP2")),
      h("p", { class: "note" }, t("confirmP3")),
    ],
    cta: t("confirmCta"), onCta: () => stepAmount(), back: () => (ORDERBOOK ? showMarket(flow.direction) : init()),
  }));
}

function stepAmount() {
  rerender = stepAmount;
  const { send, recv } = roleCoins();
  const sendIn = field(t("amountPlaceholder", { coin: send }), sats(coinSats(send)));
  const recvIn = field(t("amountPlaceholder", { coin: recv }), sats(coinSats(recv)));
  render(screen({
    title: t("howMuch"),
    body: [h("label", {}, t("youSendCoin", { coin: send })), sendIn, h("label", {}, t("youReceiveCoin", { coin: recv })), recvIn],
    cta: t("continue"),
    onCta: () => {
      flow[send === "BTC" ? "btcSats" : "qbtSats"] = toSats(sendIn.value);
      flow[recv === "BTC" ? "btcSats" : "qbtSats"] = toSats(recvIn.value);
      stepReceive();
    },
    back: () => stepConfirm(),
  }));
}

function stepReceive() {
  rerender = stepReceive;
  const { recv } = roleCoins();
  const inp = field(t("receivePlaceholder", { coin: recv }));
  if (flow.receiveAddr) inp.value = flow.receiveAddr; else prefill(inp, recv);
  render(screen({
    title: t("receiveTitle", { coin: recv }), subtitle: t("receiveSub", { coin: recv }),
    body: [inp, h("p", { class: "note" }, t("feeNote"))], cta: t("continue"),
    onCta: () => { flow.receiveAddr = validAddr(inp.value, recv); stepRefund(); },
    back: flow.mode === "create" ? () => stepAmount() : flow.mode === "take" ? () => stepTakeConfirm() : () => stepInvited(),
  }));
}

function stepRefund() {
  rerender = stepRefund;
  const { send } = roleCoins();
  const inp = field(t("refundPlaceholder", { coin: send }));
  if (flow.refundAddr) inp.value = flow.refundAddr; else prefill(inp, send);
  const cta = flow.mode === "create" ? t("createSwap") : flow.mode === "take" ? (flow.takeAction === "buy" ? t("buyNow") : t("sellNow")) : t("joinSwap");
  render(screen({
    title: t("refundTitle", { coin: send }), subtitle: t("refundSub"),
    body: [inp], cta,
    onCta: async () => {
      flow.refundAddr = validAddr(inp.value, send);
      flow.mode === "create" ? await doCreate() : flow.mode === "take" ? await doTake() : await doJoin();
    },
    back: () => stepReceive(),
  }));
}

function destsForClient() {
  const { recv } = roleCoins();
  const addrForCoin = (coin) => (coin === recv ? flow.receiveAddr : flow.refundAddr);
  return { btcDest: addrForCoin("BTC"), qbitDest: addrForCoin("QBT") };
}
async function doCreate() {
  flow.client = new SwapClient({ coordinator: flow.coordinator });
  const res = await flow.client.create({ direction: flow.direction, btcSats: flow.btcSats, qbtSats: flow.qbtSats, securityLevel: "high", ...destsForClient() });
  flow.bobLink = res.bobLink;
  await vault.save(flow.client.secrets());
  stepBackup(() => stepShare());
}
async function doJoin() {
  flow.client = new SwapClient({ coordinator: flow.coordinator });
  await flow.client.join({ id: flow.joinId, token: flow.joinToken, ...destsForClient() });
  await vault.save(flow.client.secrets());
  stepBackup(() => startLive());
}

function stepBackup(next) {
  rerender = () => stepBackup(next);
  let downloaded = false;
  const cont = h("button", { class: "primary", style: "width:100%;margin-top:16px", disabled: true, onclick: () => next() }, t("continue"));
  const chk = h("input", { type: "checkbox", style: "width:auto;margin:2px 9px 0 0;flex:0 0 auto", onchange: () => { cont.disabled = !(downloaded && chk.checked); } });
  const confirmRow = h("label", { style: "display:none;margin-top:16px;align-items:flex-start;gap:2px;font-size:13px;color:var(--fg);cursor:pointer" }, chk, h("span", {}, t("confirmSavedBackup")));
  const dl = h("button", { onclick: () => { saveFile(`qbit-swap-${flow.client.id.slice(0, 8)}.json`, exportBackup(flow.client.secrets())); downloaded = true; dl.textContent = t("backupDownloaded"); confirmRow.style.display = "flex"; } }, t("downloadBackupBtn"));
  render(h("div", { class: "card" },
    h("h2", {}, t("saveBackup")),
    h("p", { class: "note", style: "margin-top:-4px" }, t("backupSub")),
    h("p", { class: "note" }, t("backupNote")),
    h("div", { class: "btns", style: "margin-top:14px" }, dl),
    confirmRow, cont));
}

const linkBox = () => h("div", { class: "mono", style: "background:var(--panel2);padding:10px;border-radius:8px" }, flow.bobLink);
function stepShare() {
  rerender = stepShare;
  render(screen({
    title: t("shareTitle"), subtitle: t("shareSub"),
    body: [linkBox()],
    cta: t("copyLink"),
    onCta: async () => { try { await navigator.clipboard?.writeText(flow.bobLink); } catch {} stepShareConfirm(); },
  }));
}
function stepShareConfirm() {
  rerender = stepShareConfirm;
  render(screen({
    title: t("shareConfirmTitle"), subtitle: t("shareConfirmBody"),
    body: [linkBox()],
    cta: t("shareConfirmCta"), onCta: () => startLive(),
    back: () => stepShare(),
  }));
}

// ── participant entry (opened via link) ───────────────────────────────────────
async function startParticipant({ coordinator, id, token }) {
  flow.mode = "join"; flow.coordinator = coordinator; flow.joinId = id; flow.joinToken = token;
  render(screen({ title: t("loadingSwap"), body: [h("span", { class: "muted" }, t("fetchingTerms"))] }));
  const v = await (await fetch(`${coordinator}/swaps/${id}`, { headers: { "x-swap-token": token } })).json();
  flow.direction = v.direction; flow.btcSats = v.terms.btcSats; flow.qbtSats = v.terms.qbtSats;
  flow.feerates = v.feerates;
  stepInvited();
}
function stepInvited() {
  rerender = stepInvited;
  const { send, recv } = roleCoins();
  render(screen({
    title: t("invitedTitle"), subtitle: t("invitedSub"),
    body: [
      h("div", { class: "fund" },
        h("div", {}, `${t("youSend")}  `, h("b", {}, `${sats(coinSats(send))} ${send}`)),
        h("div", { style: "margin-top:4px" }, `${t("youReceive")}  `, h("b", {}, `${sats(netReceive(recv, flow.feerates).net)} ${recv}`),
          h("span", { class: "note", style: "margin-left:6px" }, t("afterFeeShort", { fee: feeStr(recv, netReceive(recv, flow.feerates).fee) })))),
      h("p", { class: "note" }, t("invitedNote")),
    ],
    cta: t("continue"), onCta: () => stepReceive(),
  }));
}

// ── live: fund + progress (one screen that morphs) ────────────────────────────
let liveCard = null;
function startLive() {
  liveCard = h("div", { class: "card" }, h("span", { class: "muted" }, "…"));
  render(liveCard);
  rerender = () => { if (flow.client?.view) renderLive(liveCard, flow.client.view); };
  flow.client.onUpdate = (v) => renderLive(liveCard, v);
  flow.client.start();
}
const STATE_CLASS = { COMPLETE: "good", REFUNDED: "warn", CLAIMABLE: "info", CLAIMED: "info", ABORTED: "bad" };
function renderLive(card, v) {
  while (card.firstChild) card.removeChild(card.firstChild);
  const { send, recv } = roleCoins();
  const fundLeg = coinLeg(send), funded = v.funding?.[fundLeg];
  const addr = v.htlc?.[fundLeg]?.address;
  const terminal = v.state === "COMPLETE" || v.state === "REFUNDED";

  const headline = terminal ? (v.state === "COMPLETE" ? t("swapComplete") : t("swapRefunded"))
    : !addr ? t("waitingCounterparty")
    : funded ? t("coinLocked", { coin: send }) : t("sendToLock", { coin: send });
  card.append(h("div", { style: "display:flex;justify-content:space-between;align-items:center" },
    h("h2", { style: "margin:0" }, headline),
    h("span", { class: "badge " + (STATE_CLASS[v.state] || "") }, v.state)));

  if (v.securityError) { liveGuard = { risky: false }; card.append(h("p", { class: "note", style: "color:var(--bad);font-weight:600;margin-top:12px" }, t("securityErr"))); return; }

  if (!terminal) {
    const online = v.counterpartyOnline;
    card.append(h("div", { class: "note statusline", style: "margin-top:8px" },
      h("span", { class: `dot ${online ? "live" : "idle"}` }),
      online ? t("cpOnline") : t("cpOffline")));
  }
  // Safety net: once both legs are funded, the client pre-signs a fee-ladder claim + refund and the
  // coordinator (watchtower) finishes even if this tab closes. Until armed, warn against leaving.
  const bothFunded = v.funding?.btc && v.funding?.qbit, armed = v.safetyNet?.self;
  liveGuard = { risky: !terminal && !!v.funding?.[fundLeg] && !armed };
  if (!terminal && bothFunded) {
    card.append(h("div", { class: "note statusline", style: `margin-top:6px;color:${armed ? "var(--good)" : "var(--warn)"}` },
      h("span", {}, armed ? "🛡️" : "⏳"), armed ? t("armedNet") : t("armingNet")));
  }
  // Watchtower is armed and we hold the pre-signed recovery ladder — let the user fold it into a backup.
  if (!terminal && armed && flow.client?.recovery) {
    if (!flow._recoverySaved) { vault.save(flow.client.secrets()).catch(() => {}); flow._recoverySaved = true; }
    card.append(h("div", { class: "btns", style: "margin-top:6px" },
      h("button", { onclick: () => saveFile(`qbit-swap-${flow.client.id.slice(0, 8)}-recovery.json`, exportBackup(flow.client.secrets())) }, t("downloadRecoveryBackup"))));
  }
  // Show what the receiver will net after the (mempool High-priority) claim fee.
  if (!terminal && v.feerates && v.htlc) {
    const { net, fee } = netReceive(recv, v.feerates);
    card.append(h("p", { class: "note" }, t("netReceive", { net: sats(net), coin: recv, fee: feeStr(recv, fee) })));
  }
  if (!terminal && flow.mode === "create" && flow.bobLink) {
    card.append(h("div", { class: "btns", style: "margin-top:8px" }, copyButton("copyInvite", "inviteCopied", () => flow.bobLink)));
  }

  if (!terminal && addr) {
    card.append(h("div", { class: "fund" },
      h("div", { class: "muted" }, funded ? t("coinLockedCheck", { coin: send }) : t("sendExactly", { coin: send })),
      h("div", { class: "amt" }, `${sats(coinSats(send))} ${send}`),
      funded ? null : h("div", { class: "mono", style: "margin-top:6px" }, addr),
      funded ? null : h("div", { class: "btns" }, copyButton("copyAddress", "copiedCheck", () => addr))));
  }

  card.append(h("p", { class: "note" }, statusLine(v, send, recv)));
  if (!terminal && v.shortFunded) card.append(h("p", { class: "note", style: "color:var(--bad)" }, t("underfundWarn")));
  if (v.actionError) card.append(h("p", { class: "note", style: "color:var(--bad)" }, "⚠ " + v.actionError));
  if (terminal) vault.purge(v.id).catch(() => {});
}
function statusLine(v, send, recv) {
  const initiator = flow.mode !== "join";   // create or take
  if (!v.htlc) return initiator ? t("stWaitJoin") : t("stSetup");
  switch (v.state) {
    case "COMPLETE": return t("stReceived", { amt: sats(coinSats(recv)), coin: recv });
    case "REFUNDED": return t("stReturned", { coin: send });
    case "CLAIMABLE": return initiator ? t("stBothFunded") : t("stWaitClaim");
    case "MATURING": return t("stMaturing");
    case "CLAIMED": return initiator ? t("stClaimed") : t("stPreimage");
    default: return v.funding?.[coinLeg(send)] ? t("stWaitFund") : t("stWaitDeposit");
  }
}

// ── resume from vault / backup ────────────────────────────────────────────────
function resumeSwap(secrets) {
  flow.mode = secrets.role === "alice" ? "create" : "join";
  flow.direction = secrets.direction; flow.coordinator = secrets.coordinator;
  flow.client = new SwapClient({ coordinator: secrets.coordinator }).restore(secrets);
  startLive();
}

// ── files + drag/drop restore ─────────────────────────────────────────────────
function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0]; if (!file) return;
  try { resumeSwap(importBackup(await file.text())); } catch (err) { alert(t("errRestore", { msg: err.message })); }
});

// ── language switcher (header) ────────────────────────────────────────────────
function renderChrome() {
  const tag = document.getElementById("tagline"); if (tag) tag.textContent = t("tagline");
  const el = document.getElementById("lang"); if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const [code, label] of LANGS) {
    el.append(h("a", { href: "#", "aria-current": getLang() === code ? "true" : "false",
      onclick: (e) => { e.preventDefault(); if (getLang() !== code) { setLang(code); renderChrome(); rerender(); } } }, label));
  }
}

renderChrome();
init();
