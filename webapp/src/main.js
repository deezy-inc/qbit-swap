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
const RECENT_TRADES = globalThis.QBIT_RECENT_TRADES === true;   // feature flag, default OFF — public recent-trades tab
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
const trimZeros = (s) => s.replace(/0+$/, "").replace(/\.$/, "");
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
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

// ── browser history: the native Back button mirrors the on-page "Back" ─────────
// This is a single-page app, but people reach for the browser Back button anyway. Every screen
// registers its Back action via markScreen(); the on-page Back link just calls history.back(), so
// both routes pop the same stack. Forward navigation pushes a state; going back runs the current
// screen's Back handler, which re-renders the previous screen (suppressed so it doesn't re-push).
let curBack = null, histSeq = 0, histPos = 0, histSuppress = false;
function markScreen(back) {
  curBack = typeof back === "function" ? back : null;
  if (histSuppress) return;              // rendering because of a back-nav or a lang re-render — don't push
  if (histSeq === 0) { histSeq = histPos = 1; history.replaceState({ pos: 1 }, ""); }   // first screen: replace, so Back off it leaves the app
  else { histPos = ++histSeq; history.pushState({ pos: histPos }, ""); }
}
window.addEventListener("popstate", (e) => {
  const target = e.state?.pos ?? 0;
  if (target < histPos && curBack) {     // going back one or more screens
    histPos = target;
    histSuppress = true;
    try { curBack(); } finally { histSuppress = false; }
  } else {
    histPos = target;                    // at the root, or a forward hop we can't reconstruct — leave the view as-is
  }
});

function screen({ title, subtitle, body = [], cta, onCta, secondary, back }) {
  markScreen(back);
  const btn = cta ? h("button", { class: "primary", style: "width:100%;margin-top:18px", onclick: async (e) => { const b = e.target; b.disabled = true; try { await onCta(); } catch (err) { b.disabled = false; alert(err.message); } } }, cta) : null;
  const backLink = back ? h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); history.back(); } }, t("back")) : null;
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
  if (q.coord && q.id && q.token) {
    // Re-opened the invite link and we already hold this swap's keys → resume it (don't re-join with
    // fresh keys, which the coordinator would reject as "already joined by someone else").
    const known = (await vault.list().catch(() => [])).includes(q.id);
    if (known) { try { return resumeSwap(await vault.load(q.id)); } catch { /* fall through to fresh join */ } }
    return startParticipant({ coordinator: decodeURIComponent(q.coord), id: q.id, token: q.token });
  }
  // The root URL always opens on the hero landing — even for a returning user. Any in-progress swaps
  // are still one click away: "Start a swap" → the chooser lists them, and the backup-recover card is there too.
  stepWelcome();
}

// Qbit orbit emblem — the brand mark with its dot + ring as a spinning "orbit" group around the core.
const EMBLEM_SVG = `<svg viewBox="0 0 320 320" aria-hidden="true"><path class="core" d="m159.745 75.5137c46.2 0 83.652 37.4503 83.652 83.6483 0 46.197-37.452 83.648-83.652 83.648-46.199 0-83.6516-37.451-83.6516-83.648 0-46.198 37.4526-83.6483 83.6516-83.6483z"/><g class="orbit"><path d="m264.882 234.338c16.044 0 29.049 13.005 29.049 29.048 0 16.042-13.005 29.048-29.049 29.048-16.043 0-29.049-13.006-29.049-29.048 0-16.043 13.006-29.048 29.049-29.048z"/><path d="m46.1611 46.159c62.0959-62.0934 163.4069-61.4602 226.2849 1.4142 41.915 41.9136 56.167 100.9048 42.618 153.9748l-.026-.007c-1.478 5.001-6.104 8.652-11.584 8.652-6.672-.001-12.081-5.409-12.081-12.081 0-1.328.217-2.605.613-3.8 11.713-45.226-.14-95.2914-35.565-130.715-53.246-53.2434-139.575-53.2434-192.821 0-53.2456 53.243-53.2452 139.568.0007 192.812 35.4457 35.444 85.5513 47.29 130.7993 35.543 1.17-.377 2.416-.582 3.711-.582 6.672 0 12.081 5.408 12.081 12.08 0 5.477-3.645 10.099-8.642 11.58l.006.02c-53.071 13.548-112.0653-.704-153.9806-42.617-62.8774-62.874-63.5106-164.181-1.4143-226.274z"/></g></svg>`;

// Landing page — hero + call-to-action + value props.
function stepWelcome() {
  rerender = stepWelcome;
  markScreen(null);   // root screen — Back off the landing leaves the app
  const feature = (n) => h("div", { class: "feature" },
    h("div", { class: "flabel" }, h("span", { class: "fdot" }), t("feat" + n)),
    h("p", {}, t("feat" + n + "d")));
  render(h("div", { class: "landing" },
    h("section", { class: "hero" },
      h("div", { class: "hero-emblem", html: EMBLEM_SVG }),
      h("div", { class: "hero-kicker" }, t("heroKicker")),
      h("h1", {}, t("heroTitle")),
      h("p", { class: "hero-sub" }, t("heroSub")),
      h("div", { class: "hero-cta" },
        h("button", { class: "primary btn-lg", onclick: () => stepChoose() }, t("heroStart")),
        h("button", { class: "btn-lg btn-ghost", onclick: () => stepInfo() }, t("heroLearn"))),
    ),
    h("section", { class: "features" },
      h("h2", {}, t("featTitle")),
      h("div", { class: "feature-grid" }, feature(1), feature(2), feature(3), feature(4), feature(5), feature(6))),
    h("section", { class: "steps-section" },
      h("h2", {}, t("stepsTitle")),
      h("div", { class: "steps" },
        stepRow(1, h("p", {}, t("step1dPre"),
          h("a", { href: "https://discord.gg/xqC7MAk95Q", target: "_blank", rel: "noopener" }, t("confirmDiscordLink")),
          t("step1dPost"))),
        stepRow(2), stepRow(3), stepRow(4), stepRow(5), stepRow(6), stepRow(7))),
  ));
}
const stepRow = (n, detail) => h("div", { class: "step" },
  h("div", { class: "step-num" }, n),
  h("div", { class: "step-body" }, h("b", {}, t("step" + n + "t")), detail || h("p", {}, t("step" + n + "d"))));

// Direction chooser + resume/recover.
async function stepChoose(resumable) {
  rerender = () => stepChoose(resumable);
  const list = resumable || (await vault.list().catch(() => []));
  render(h("div", {},
    screen({
      title: t("swapWhichWay"), subtitle: t("nonCustodial"),
      body: [
        bigChoice("₿", t("haveBtc"), t("haveBtcSub"), () => chooseDirection("btc2qbt")),
        bigChoice("Q", t("haveQbt"), t("haveQbtSub"), () => chooseDirection("qbt2btc")),
      ],
      back: () => stepWelcome(),
    }),
    await recoverCard(list),
  ));
}

// Info / how-it-works + FAQ (reached from the header tab; Back returns to where you were).
let _prevView = null;
function stepInfo() {
  if (rerender !== stepInfo) _prevView = rerender;
  rerender = stepInfo;
  const step = (n, k) => h("div", { class: "note", style: "display:flex;gap:9px;margin-top:9px" },
    h("span", { style: "color:var(--accent);font-weight:700" }, n + "."), h("span", {}, t(k)));
  const faq = (q, a) => h("div", { style: "margin-top:16px" },
    h("div", { style: "font-weight:600;color:var(--ink)" }, t(q)),
    h("p", { class: "note", style: "margin-top:3px" }, t(a)));
  const faqLink = (q, a, href, linkText) => h("div", { style: "margin-top:16px" },
    h("div", { style: "font-weight:600;color:var(--ink)" }, t(q)),
    h("p", { class: "note", style: "margin-top:3px" }, t(a), " ",
      h("a", { href, target: "_blank", rel: "noopener", style: "color:var(--accent)" }, linkText)));
  const tech = (n) => h("div", { style: "margin-top:14px" },
    h("div", { style: "font-weight:600;color:var(--ink)" }, t("tech" + n + "l")),
    h("p", { class: "note", style: "margin-top:3px" }, t("tech" + n + "d")));
  render(screen({
    title: t("infoHowTitle"),
    body: [
      h("p", { class: "note" }, t("infoIntro")),
      step(1, "infoStep1"), step(2, "infoStep2"), step(3, "infoStep3"), step(4, "infoStep4"),
      h("h2", { style: "margin:24px 0 0" }, t("infoFaqTitle")),
      faqLink("faqWhatQ", "faqWhatA", "https://qbit.org/", "qbit.org"),
      faq("faqCustodialQ", "faqCustodialA"), faq("faqStallQ", "faqStallA"), faq("faqHowLongQ", "faqHowLongA"),
      faq("faqFindQ", "faqFindA"), faq("faqFeesQ", "faqFeesA"), faq("faqWalletQ", "faqWalletA"), faq("faqBackupQ", "faqBackupA"),
      h("h2", { style: "margin:24px 0 0" }, t("techTitle")),
      tech(1), tech(2), tech(3), tech(4), tech(5), tech(6), tech(7), tech(8),
    ],
    back: () => { rerender = _prevView || (() => init()); rerender(); },
  }));
}

// Recent trades — a public feed of successfully settled swaps (feature-flagged, header tab).
async function stepTrades() {
  if (rerender !== stepTrades) _prevView = rerender;
  rerender = stepTrades;
  const back = () => { rerender = _prevView || (() => init()); rerender(); };
  let trades = null;
  try { trades = await coordGet("/trades"); } catch { trades = []; }
  const body = [h("p", { class: "note", style: "margin-top:-4px" }, t("tradesNote"))];
  if (!trades.length) {
    body.push(h("p", { class: "muted", style: "margin-top:16px" }, t("tradesEmpty")));
  } else {
    const rows = trades.map((tr) => h("tr", {},
      h("td", {}, `${sats(tr.qbtSats)} QBT`),
      h("td", {}, `${sats(tr.btcSats)} BTC`),
      h("td", {}, `${trimZeros(tr.price.toFixed(8))} BTC/QBT`),
      h("td", { class: "when" }, tr.settledAt ? ago(tr.settledAt) : "—")));
    body.push(h("table", { class: "trades" },
      h("thead", {}, h("tr", {}, h("th", {}, "QBT"), h("th", {}, "BTC"), h("th", {}, t("priceLabel")), h("th", {}, t("tradesWhen")))),
      h("tbody", {}, ...rows)));
  }
  render(screen({ title: t("tradesTitle"), body, back }));
}

function chooseDirection(direction) {
  flow.direction = direction;
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
  const card = h("div", { class: "card secondary" }, h("h2", {}, t("recoverTitle")), h("p", { class: "note" }, t("recoverBody")));
  for (const id of ids) {
    const s = await vault.load(id);
    const label = (s.qbtSats != null && s.btcSats != null)
      ? t(s.direction === "btc2qbt" ? "resumeBuy" : "resumeSell", { qbt: sats(s.qbtSats), btc: sats(s.btcSats) })
      : t("resumeBtn", { from: DIR[s.direction]?.from, to: DIR[s.direction]?.to, id: shorten(id, 6) });
    card.append(h("button", { class: "primary", style: "width:100%;margin-top:8px", onclick: () => resumeSwap(s) }, label));
  }
  const fileInput = h("input", { type: "file", accept: "application/json", style: "display:none", onchange: async (e) => { const f = e.target.files?.[0]; if (!f) return; try { resumeSwap(importBackup(await f.text())); } catch (err) { alert(t("errReadBackup", { msg: err.message })); } } });
  card.append(fileInput, h("div", { class: "btns", style: "margin-top:10px" }, h("button", { style: "font-size:12.5px; padding:7px 12px", onclick: () => fileInput.click() }, ids.length ? t("uploadInstead") : t("uploadBackup"))));
  return card;
}

function stepConfirm() {
  rerender = stepConfirm;
  const d = DIR[flow.direction];
  render(screen({
    title: t("beforeBegin"), subtitle: t("confirmSub"),
    body: [
      h("p", { class: "note" }, t("confirmP1", { from: d.from, to: d.to })),
      h("p", { style: "font-size:19px;font-weight:660;letter-spacing:-.015em;line-height:1.3;color:var(--ink);margin:14px 0 4px" }, t("confirmKey")),
      h("p", { class: "note", style: "margin-top:2px" }, t("confirmP1b")),
      h("p", { class: "note" }, t("confirmP2")),
      h("p", { class: "note" }, t("confirmP3")),
      h("p", { class: "note" }, t("confirmDiscordPre"),
        h("a", { href: "https://discord.gg/xqC7MAk95Q", target: "_blank", rel: "noopener" }, t("confirmDiscordLink")),
        t("confirmDiscordPost")),
    ],
    cta: t("confirmCta"), onCta: () => stepAmount(), back: () => (ORDERBOOK ? showMarket(flow.direction) : stepChoose()),
  }));
}

// BTC/USD from CoinGecko, cached ~2 min (for the optional price helper on the amounts step).
let _btcUsd = { v: 0, at: 0 };
async function btcUsdPrice() {
  if (_btcUsd.v && Date.now() - _btcUsd.at < 120000) return _btcUsd.v;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const v = (await r.json())?.bitcoin?.usd;
    if (v > 0) _btcUsd = { v, at: Date.now() };
  } catch { /* offline / rate-limited → $ mode just stays blank; ₿ mode still works */ }
  return _btcUsd.v;
}
let priceMode = "usd";   // "usd" | "btc", persists across re-renders

function stepAmount() {
  rerender = stepAmount;
  const { send, recv } = roleCoins();
  const sendIn = field(t("amountPlaceholder", { coin: send }), coinSats(send) ? sats(coinSats(send)) : "");
  const recvIn = field(t("amountPlaceholder", { coin: recv }), coinSats(recv) ? sats(coinSats(recv)) : "");
  const btcIn = send === "BTC" ? sendIn : recvIn;   // which input holds BTC / QBT (direction-independent)
  const qbtIn = send === "BTC" ? recvIn : sendIn;

  // Price helper: shows $ (or ₿) per QBT, kept in sync with the amounts. Editing it adjusts the BTC
  // amount so the price matches (QBT fixed). A toggle switches the unit; BTCUSD is the cached CoinGecko rate.
  const unitKey = () => (priceMode === "usd" ? "priceUsd" : "priceBtc");
  const priceIn = field(t(unitKey()));
  const unitBtn = h("button", { type: "button", class: "copy", onclick: () => { priceMode = priceMode === "usd" ? "btc" : "usd"; unitBtn.textContent = t(unitKey()); priceIn.placeholder = t(unitKey()); syncPrice(); } }, t(unitKey()));
  const num = (el) => { const n = parseFloat(el.value); return isFinite(n) && n > 0 ? n : 0; };
  const trim = (n) => n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  let usd = 0;
  function syncPrice() {            // amounts → price field
    const b = num(btcIn), q = num(qbtIn);
    if (!b || !q) { priceIn.value = ""; return; }
    const btcPerQbt = b / q;
    priceIn.value = priceMode === "usd" ? (usd ? (btcPerQbt * usd).toFixed(4) : "") : trim(btcPerQbt);
  }
  function applyPrice() {           // price field → BTC amount (QBT fixed)
    const p = num(priceIn), q = num(qbtIn);
    if (!p || !q) return;
    const btcPerQbt = priceMode === "usd" ? (usd ? p / usd : 0) : p;
    if (btcPerQbt) btcIn.value = trim(btcPerQbt * q);
  }
  sendIn.oninput = recvIn.oninput = syncPrice;
  priceIn.oninput = applyPrice;
  btcUsdPrice().then((u) => { usd = u; if (priceMode === "usd") syncPrice(); });
  syncPrice();

  render(screen({
    title: t("howMuch"),
    body: [
      h("label", {}, t("youSendCoin", { coin: send })), sendIn,
      h("label", {}, t("youReceiveCoin", { coin: recv })), recvIn,
      h("div", { style: "display:flex;align-items:center;gap:9px;margin:14px 0 5px" },
        h("span", { style: "font-size:12.5px;font-weight:550;color:var(--mut)" }, t("priceLabel")), unitBtn),
      priceIn,
    ],
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
    title: t("receiveTitle", { coin: recv }),
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
    title: t("refundTitle", { coin: send }),
    body: [h("p", { class: "note", style: "margin:18px 0 22px" }, t("refundSub")), inp], cta,
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
  try {
    await flow.client.join({ id: flow.joinId, token: flow.joinToken, ...destsForClient() });
  } catch (e) {
    if (/already been joined|already joined/i.test(e.message || "")) throw new Error(t("errAlreadyJoined"));
    throw e;
  }
  await vault.save(flow.client.secrets());
  stepBackup(() => startLive());
}

function stepBackup(next) {
  rerender = () => stepBackup(next);
  markScreen(null);
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
  // Copy reveals the Continue button (which goes straight live) — no intermediate confirm slide.
  const cont = h("button", { class: "primary", style: "width:100%;margin-top:12px;display:none", onclick: () => startLive() }, t("continue"));
  const copyBtn = h("button", { class: "primary", style: "width:100%;margin-top:16px", onclick: async () => {
    try { await navigator.clipboard?.writeText(flow.bobLink); } catch {}
    copyBtn.textContent = t("copiedCheck");
    cont.style.display = "block";
  } }, t("copyLink"));
  render(screen({
    title: t("shareTitle"), subtitle: t("shareSub"),
    body: [linkBox(), copyBtn, cont],
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
  flow.client.stop();   // idempotent: safe if we came back from the share screen and re-enter
  liveCard = h("div", { class: "card" }, h("span", { class: "muted" }, "…"));
  render(liveCard);
  markScreen(null);   // swap is committed here — no Back handler, so the browser Back button won't drop you out of a live swap
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

  // While waiting for the counterparty, show the deal prominently.
  if (!terminal && !addr) {
    card.append(h("div", { style: "font-size:19px;font-weight:640;letter-spacing:-.01em;margin-top:14px;line-height:1.4" },
      t("sendingReceiving", { outAmt: `${sats(coinSats(send))} ${send}`, inAmt: `${sats(coinSats(recv))} ${recv}` }),
      " ",
      h("span", { class: "note", style: "font-weight:400;font-size:13px" }, t("minusFees"))));
  }

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
  // While waiting for the counterparty, let the creator go back to the share screen.
  if (!terminal && !addr && flow.mode === "create") {
    card.append(h("div", { style: "margin-top:14px" },
      h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); stepShare(); } }, t("back"))));
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
  const info = document.getElementById("info-link"); if (info) info.textContent = t("infoTab");
  const trades = document.getElementById("trades-link"); if (trades) trades.textContent = t("tradesTab");
  const el = document.getElementById("lang"); if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const [code, label] of LANGS) {
    el.append(h("a", { href: "#", "aria-current": getLang() === code ? "true" : "false",
      onclick: (e) => { e.preventDefault(); if (getLang() !== code) { setLang(code); syncLangUrl(); renderChrome(); histSuppress = true; try { rerender(); } finally { histSuppress = false; } } } }, label));
  }
}

// Clicking the Qbit logo clears the current flow and returns to the home screen.
function goHome() {
  flow.client?.stop?.();
  Object.assign(flow, { mode: null, direction: null, btcSats: 0, qbtSats: 0, receiveAddr: "", refundAddr: "", client: null, bobLink: null, _recoverySaved: false });
  liveGuard = { risky: false };
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  stepWelcome();   // always return to the hero landing, not the direction chooser
}
for (const sel of ["header .mark", "header h1"]) document.querySelector(sel)?.addEventListener("click", goHome);
document.querySelector("#info-link")?.addEventListener("click", (e) => { e.preventDefault(); stepInfo(); });
if (RECENT_TRADES) {
  const tl = document.getElementById("trades-link"), il = document.getElementById("info-link");
  if (tl) { tl.style.display = ""; tl.style.marginLeft = "auto"; if (il) il.style.marginLeft = "0"; tl.addEventListener("click", (e) => { e.preventDefault(); stepTrades(); }); }
}

// Reflect the active language in the address bar so a copied/shared link carries it (zh → ?lang=zh;
// English stays a clean URL). Preserves the nav-history state and the invite hash.
function syncLangUrl() {
  const u = new URL(location.href);
  if (getLang() === "en") u.searchParams.delete("lang"); else u.searchParams.set("lang", getLang());
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}

renderChrome();
init();
syncLangUrl();
