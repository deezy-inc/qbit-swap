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
// All SwapClients get the BTC network (hrp) so they can fall back to a direct public broadcast of the
// BTC leg if the coordinator is unreachable while the tab is open (see swapflow.js #send).
const mkClient = (opts) => new SwapClient({ btcHrp: HRPS.btc, ...opts });
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
// Every swap is btc2qbt under the hood (initiator=alice=QBT buyer, sends BTC). A party's personal
// orientation is just a view of their role: alice sends BTC / sells nothing (buys QBT); bob sends QBT.
const DIR = { btc2qbt: { from: "BTC", to: "QBT" }, qbt2btc: { from: "QBT", to: "BTC" } };
const dirForRole = (role) => (role === "bob" ? "qbt2btc" : "btc2qbt");
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
const flow = { mode: null, role: null, direction: null, coordinator: DEFAULT_COORD, btcSats: 0, qbtSats: 0, receiveAddr: "", refundAddr: "", client: null, inviteLink: null };
const coinSats = (coin) => (coin === "BTC" ? flow.btcSats : flow.qbtSats);
// What THIS party sends/receives, from their role: alice (QBT buyer) sends BTC & receives QBT; bob
// (QBT seller) sends QBT & receives BTC. Independent of who created the swap.
const roleCoins = () => (flow.role === "bob" ? { send: "QBT", recv: "BTC" } : { send: "BTC", recv: "QBT" });
// coordinator REST helpers (the order book lives outside the per-party SwapClient)
const coordUrl = (p) => `${DEFAULT_COORD}${p}`;
const coordGet = async (p) => { const r = await fetch(coordUrl(p)); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };
const coordPost = async (p, body) => { const r = await fetch(coordUrl(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };

// ── entry ─────────────────────────────────────────────────────────────────────
async function init() {
  rerender = () => init();
  const q = parseHash();
  if (q.id) {
    // We already hold this swap's keys (either party) → resume it, so a page refresh on the live status
    // page returns to the swap instead of the landing. This covers both the creator's #id permalink and
    // a re-opened invite link. Don't re-join with fresh keys — the coordinator rejects that as taken.
    const known = (await vault.list().catch(() => [])).includes(q.id);
    if (known) { try { return resumeSwap(await vault.load(q.id)); } catch { /* fall through to fresh join */ } }
    // Not ours yet: a full invite link (coord+id+token) means we're the invited participant → join fresh.
    if (q.coord && q.token) return startParticipant({ coordinator: decodeURIComponent(q.coord), id: q.id, token: q.token });
  }
  // The root URL always opens on the hero landing — even for a returning user. Any in-progress swaps
  // are still one click away: "Start a swap" → the chooser lists them, and the backup-recover card is there too.
  stepWelcome();
}

// Qbit orbit emblem — the brand mark with its dot + ring as a spinning "orbit" group around the core.
// Centered spinning orbit emblem — the loading indicator while a swap view / backup loads.
const spinnerEl = (label) => h("div", { style: "display:flex;flex-direction:column;align-items:center;gap:14px;padding:44px 0 36px" },
  h("div", { class: "hero-emblem boot", style: "margin:0;width:60px", html: EMBLEM_SVG }),
  label ? h("span", { class: "muted", style: "font-size:14px" }, label) : null);
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
    h("section", { class: "about" },
      h("h2", {}, t("aboutQbitTitle")),
      h("p", { class: "about-body" }, t("aboutQbitBody"), " ",
        h("a", { href: "https://qbit.org/", target: "_blank", rel: "noopener" }, "qbit.org"))),
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

// Header for a full-width content page (Info / Activity): big title + a Back link that drives history.
const pageHead = (title, back) => h("div", { class: "page-head" },
  h("h1", {}, title),
  back ? h("a", { class: "page-back", href: "#", onclick: (e) => { e.preventDefault(); history.back(); } }, t("back")) : null);

// Info / how-it-works + FAQ + technical details — a wide, landing-style page (reached from the header
// tab; Back returns to where you were).
let _prevView = null;
function stepInfo() {
  if (rerender !== stepInfo) _prevView = rerender;
  rerender = stepInfo;
  const back = () => { rerender = _prevView || (() => init()); rerender(); };
  markScreen(back);
  const infoStep = (n, k) => h("div", { class: "info-step" }, h("span", { class: "n" }, n), h("p", {}, t(k)));
  const qa = (q, a, link) => h("div", { class: "qa" },
    h("div", { class: "q" }, t(q)),
    h("p", { class: "a" }, t(a), ...(link ? [" ", h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text)] : [])));
  const techQa = (n) => h("div", { class: "qa" }, h("div", { class: "q" }, t("tech" + n + "l")), h("p", { class: "a" }, t("tech" + n + "d")));
  render(h("div", { class: "page" },
    pageHead(t("infoHowTitle"), back),
    h("p", { class: "page-intro" }, t("infoIntro")),
    h("div", { class: "info-steps" }, infoStep(1, "infoStep1"), infoStep(2, "infoStep2"), infoStep(3, "infoStep3"), infoStep(4, "infoStep4")),
    h("section", { class: "page-section" },
      h("h2", {}, t("infoFaqTitle")),
      h("div", { class: "qa-grid" },
        qa("faqWhatQ", "faqWhatA", { href: "https://qbit.org/", text: "qbit.org" }),
        qa("faqCustodialQ", "faqCustodialA"), qa("faqStallQ", "faqStallA"), qa("faqHowLongQ", "faqHowLongA"),
        qa("faqFindQ", "faqFindA"), qa("faqFeesQ", "faqFeesA"), qa("faqWalletQ", "faqWalletA"), qa("faqBackupQ", "faqBackupA"))),
    h("section", { class: "page-section" },
      h("h2", {}, t("techTitle")),
      h("div", { class: "qa-grid" }, techQa(1), techQa(2), techQa(3), techQa(4), techQa(5), techQa(6), techQa(7), techQa(8))),
  ));
}

// Activity — a public feed of successfully settled swaps (feature-flagged, header tab).
async function stepTrades() {
  if (rerender !== stepTrades) _prevView = rerender;
  rerender = stepTrades;
  const back = () => { rerender = _prevView || (() => init()); rerender(); };
  markScreen(back);
  let trades = null;
  try { trades = await coordGet("/trades"); } catch { trades = []; }
  let btcUsd = 0;
  try { btcUsd = await btcUsdPrice(); } catch { /* CoinGecko unavailable → USD column shows — */ }   // cached 2 min
  let content;
  if (!trades.length) {
    content = h("p", { class: "muted", style: "margin-top:24px" }, t("tradesEmpty"));
  } else {
    const usdCell = (tr) => (btcUsd ? `$${trimZeros((tr.price * btcUsd).toFixed(4))}` : "—");   // USD per QBT = (BTC/QBT) × BTCUSD
    const rows = trades.map((tr) => h("tr", {},
      h("td", {}, `${sats(tr.qbtSats)} QBT`),
      h("td", {}, `${sats(tr.btcSats)} BTC`),
      h("td", {}, trimZeros(tr.price.toFixed(8))),
      h("td", {}, usdCell(tr)),
      h("td", { class: "when" }, tr.settledAt ? ago(tr.settledAt) : "—")));
    content = h("div", { class: "trades-card" }, h("table", { class: "trades" },
      h("thead", {}, h("tr", {}, h("th", {}, "QBT"), h("th", {}, "BTC"), h("th", {}, t("tradesPriceBtc")), h("th", {}, t("tradesPriceUsd")), h("th", {}, t("tradesWhen")))),
      h("tbody", {}, ...rows)));
  }
  render(h("div", { class: "page" },
    pageHead(t("tradesTitle"), back),
    h("p", { class: "page-intro" }, t("tradesNote")),
    content,
  ));
}

function chooseDirection(direction) {
  flow.direction = direction;
  // The creator's own role: buying QBT (btc2qbt) → initiator (alice); selling QBT (qbt2btc) →
  // participant (bob). The QBT buyer is always the initiator, so a seller-creator shares the alice link.
  flow.role = direction === "btc2qbt" ? "alice" : "bob";
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
    const take = await coordPost(`/offers/${o.id}/take`);       // { swapId, takerToken, role, terms }
    clearInterval(window._bookTimer);
    flow.mode = "take"; flow.takeAction = action; flow.role = take.role; flow.direction = dirForRole(take.role);
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
  flow.client = mkClient({ coordinator: flow.coordinator || DEFAULT_COORD });
  await flow.client.enter({ id: flow.takeSwapId, token: flow.takeToken, direction: "btc2qbt", role: flow.role, ...destsForClient() });
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
  const active = [];
  for (const id of ids) { const s = await vault.load(id).catch(() => null); if (s && !s.done) active.push([id, s]); }   // hide finished swaps
  for (const [id, s] of active) {
    const label = (s.qbtSats != null && s.btcSats != null)
      ? t(s.role === "alice" ? "resumeBuy" : "resumeSell", { qbt: sats(s.qbtSats), btc: sats(s.btcSats) })
      : t("resumeBtn", { from: DIR[dirForRole(s.role)]?.from, to: DIR[dirForRole(s.role)]?.to, id: shorten(id, 6) });
    card.append(h("button", { class: "primary", style: "width:100%;margin-top:8px", onclick: () => resumeSwap(s) }, label));
  }
  const fileInput = h("input", { type: "file", accept: "application/json", style: "display:none", onchange: async (e) => { const f = e.target.files?.[0]; if (!f) return; try { resumeSwap(importBackup(await f.text())); } catch (err) { alert(t("errReadBackup", { msg: err.message })); } } });
  card.append(fileInput, h("div", { class: "btns", style: "margin-top:10px" }, h("button", { style: "font-size:12.5px; padding:7px 12px", onclick: () => fileInput.click() }, active.length ? t("uploadInstead") : t("uploadBackup"))));
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

  // Price helper: shows $ (or ₿) per QBT. QBT, BTC and price are three linked fields; whichever you
  // edited least recently is the one we recompute, so editing any two keeps them and the third follows
  // (a standard 3-field calculator). A toggle switches the unit; BTCUSD is the cached CoinGecko rate.
  const unitKey = () => (priceMode === "usd" ? "priceUsd" : "priceBtc");
  const priceIn = field(t(unitKey()));
  const num = (el) => { const n = parseFloat(el.value); return isFinite(n) && n > 0 ? n : 0; };
  const trim = (n) => n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  let usd = 0;
  const bpqFromPrice = () => { const p = num(priceIn); return priceMode === "usd" ? (usd ? p / usd : 0) : p; };  // price field → BTC-per-QBT
  let order = ["qbt", "btc", "price"];   // most-recently-edited first; order[2] (price, initially) is recomputed
  function recompute() {
    const target = order[2];
    if (target === "price") {
      const b = num(btcIn), q = num(qbtIn);
      priceIn.value = (!b || !q) ? "" : (priceMode === "usd" ? (usd ? (b / q * usd).toFixed(4) : "") : trim(b / q));
    } else if (target === "btc") {
      const q = num(qbtIn), bpq = bpqFromPrice();
      if (q && bpq) btcIn.value = trim(bpq * q);
    } else {   // qbt
      const b = num(btcIn), bpq = bpqFromPrice();
      if (b && bpq) qbtIn.value = trim(b / bpq);
    }
  }
  const touch = (fieldId) => { order = [fieldId, ...order.filter((x) => x !== fieldId)]; recompute(); };
  const unitBtn = h("button", { type: "button", class: "copy", onclick: () => {
    priceMode = priceMode === "usd" ? "btc" : "usd"; unitBtn.textContent = t(unitKey()); priceIn.placeholder = t(unitKey());
    order = [...order.filter((x) => x !== "price"), "price"]; recompute();   // re-derive the shown price from the amounts in the new unit
  } }, t(unitKey()));
  qbtIn.oninput = () => touch("qbt");
  btcIn.oninput = () => touch("btc");
  priceIn.oninput = () => touch("price");
  btcUsdPrice().then((u) => { usd = u; recompute(); });
  recompute();

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
  flow.client = mkClient({ coordinator: flow.coordinator });
  const res = await flow.client.create({ role: flow.role, btcSats: flow.btcSats, qbtSats: flow.qbtSats, securityLevel: "high", ...destsForClient() });
  flow.inviteLink = res.inviteLink;
  await vault.save(flow.client.secrets());
  stepBackup(() => stepShare());
}
async function doJoin() {
  flow.client = mkClient({ coordinator: flow.coordinator });
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

const linkBox = () => h("div", { class: "mono", style: "background:var(--panel2);padding:10px;border-radius:8px" }, flow.inviteLink);
function stepShare() {
  rerender = stepShare;
  // Copy reveals the Continue button (which goes straight live) — no intermediate confirm slide.
  const cont = h("button", { class: "primary", style: "width:100%;margin-top:12px;display:none", onclick: () => startLive() }, t("continue"));
  const copyBtn = h("button", { class: "primary", style: "width:100%;margin-top:16px", onclick: async () => {
    try { await navigator.clipboard?.writeText(flow.inviteLink); } catch {}
    copyBtn.textContent = t("copiedCheck");
    cont.style.display = "block";
  } }, t("copyLink"));
  render(screen({
    title: t("shareTitle"), subtitle: t("shareSub"),
    body: [linkBox(), copyBtn, cont],
  }));
}

// ── participant entry (opened via link) ───────────────────────────────────────
// While the participant is filling in their details (pre-join, no swap client yet), ping the coordinator
// so it keeps seeing them as online — otherwise their presence expires and the creator sees "offline"
// even though they're actively entering info. The live client's SSE takes over once they join.
function startJoinHeartbeat(coordinator, id, token) {
  stopJoinHeartbeat();
  const ping = () => fetch(`${coordinator}/swaps/${id}`, { headers: { "x-swap-token": token } }).catch(() => {});
  ping();
  flow._joinHeartbeat = setInterval(ping, 8000);   // < the coordinator's 15s presence window
}
function stopJoinHeartbeat() { if (flow._joinHeartbeat) { clearInterval(flow._joinHeartbeat); flow._joinHeartbeat = null; } }

async function startParticipant({ coordinator, id, token }) {
  flow.mode = "join"; flow.coordinator = coordinator; flow.joinId = id; flow.joinToken = token;
  render(screen({ title: t("loadingSwap"), body: [spinnerEl(t("fetchingTerms"))] }));
  const v = await (await fetch(`${coordinator}/swaps/${id}`, { headers: { "x-swap-token": token } })).json();
  if (v.state === "CANCELED") {   // creator called it off before it started — don't send them through the join flow
    markScreen(null);
    return render(screen({ title: t("swapCanceled"), body: [h("p", { class: "note" }, v.canceled?.byYou ? t("cancelByYou") : t("cancelByCp"))] }));
  }
  if (v.state === "COMPLETE" || v.state === "REFUNDED") {
    // Reopened the invite link after the swap finished (in a browser without the saved keys) — show the
    // final status read-only from the coordinator view, not the "you've been invited" join flow.
    flow.client?.stop?.(); flow.client = null;
    flow.role = v.role; flow.direction = dirForRole(v.role);
    flow.btcSats = v.terms?.btcSats || 0; flow.qbtSats = v.terms?.qbtSats || 0; flow.feerates = v.feerates;
    const card = h("div", { class: "card" });
    markScreen(null); render(card); return renderLive(card, v);
  }
  startJoinHeartbeat(coordinator, id, token);   // keep presence alive through the entering-info screens
  // Our role comes from the token (the coordinator knows which side it controls); our send/receive
  // orientation follows from it. A joiner may be the initiator (alice) if the creator was selling QBT.
  flow.role = v.role; flow.direction = dirForRole(v.role);
  flow.btcSats = v.terms.btcSats; flow.qbtSats = v.terms.qbtSats;
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
  stopJoinHeartbeat();   // the live client's SSE now maintains presence
  flow.client.stop();   // idempotent: safe if we came back from the share screen and re-enter
  liveCard = h("div", { class: "card" }, spinnerEl());
  render(liveCard);
  markScreen(null);   // swap is committed here — no Back handler, so the browser Back button won't drop you out of a live swap
  // Stamp a token-free permalink (#id=…) so a refresh resumes from the vault instead of the landing —
  // works for the creator too, who otherwise has a bare URL. replaceState doesn't fire hashchange.
  if (flow.client?.id) history.replaceState(history.state, "", location.pathname + location.search + "#id=" + flow.client.id);
  rerender = () => { if (flow.client?.view) renderLive(liveCard, flow.client.view); };
  flow.client.onUpdate = (v) => renderLive(liveCard, v);
  flow.client.start();
}
const STATE_CLASS = { COMPLETE: "good", REFUNDED: "warn", CLAIMABLE: "info", CLAIMED: "info", ABORTED: "bad", CANCELED: "warn" };
// Public block explorers for the tx links in the timeline.
const EXPLORER = { btc: "https://mempool.space/tx/", qbit: "https://qbitmempool.robertclarke.com/tx/" };
const txLink = (leg, txid) => h("a", { href: EXPLORER[leg] + txid, target: "_blank", rel: "noopener" }, shorten(txid, 8));
// Confirmation progress under a deposit: "X / Y confirmations · ~Zm" for the reorg-safe-gated leg,
// or just "X confirmations" for the other. ETA uses average mainnet block times.
const AVG_BLOCK = { btc: 600, qbit: 60 };
const etaCompact = (secs) => secs <= 0 ? "" : secs < 60 ? " · <1m" : secs < 3600 ? ` · ~${Math.round(secs / 60)}m` : ` · ~${Math.round(secs / 3600 * 10) / 10}h`;
// The reorg-safe confirmation target for a leg: the claimed coin (toLeg) vs the funding coin (fromLeg,
// which must bury before the preimage is revealed). 0 if this view carries no target for it.
const legTarget = (v, leg) => ((leg === v.roles?.toLeg ? v.confsTarget?.confs : leg === v.roles?.fromLeg ? v.fromConfsTarget?.confs : 0) || 0);
// A funding deposit is "buried" — safe to check off — only once it reaches that target (or is already
// spent), not merely when it's detected in the mempool.
function fundBuried(v, leg, fund) {
  if (!fund) return false;
  if (fund.spent) return true;
  if (fund.unconfirmed || fund.height == null) return false;
  const confs = Math.max(0, (v.heights?.[leg] || 0) - fund.height + 1);
  return confs >= (legTarget(v, leg) || 1);
}
function confSub(v, leg, fund) {
  if (!fund || fund.unconfirmed || fund.height == null) return null;
  const confs = Math.max(0, (v.heights?.[leg] || 0) - fund.height + 1);
  const target = legTarget(v, leg);
  if (!(target > 0)) return t("confCount", { confs });
  const remaining = Math.max(0, target - confs);
  return t("confLine", { confs, target }) + (remaining > 0 ? etaCompact(remaining * (AVG_BLOCK[leg] || 60)) : "");
}

// A persistent progress timeline for the swap: every step stays visible (matched → you sent →
// counterparty sent → you received / refunded), each with a checkmark and a link to the transaction
// on a public explorer, so the whole history — including the final txid — remains on the page.
function swapTimeline(v, send, recv) {
  const fundLeg = coinLeg(send), claimLeg = coinLeg(recv);
  const myFund = v.funding?.[fundLeg], cpFund = v.funding?.[claimLeg];
  const myClaim = v.broadcasts?.[`${claimLeg}:claim`];      // the tx that delivers your received coin
  const myRefund = v.broadcasts?.[`${fundLeg}:refund`];     // your refund tx on abort
  const complete = v.state === "COMPLETE", refunded = v.state === "REFUNDED";
  // Labels are tense-aware: they flip to past tense once the deposit is SENT (`reached`), but the
  // checkmark only fills once that deposit is BURIED to its required depth (`done`) — not merely seen in
  // the mempool. So a funding step reads "You sent BTC · in mempool · 0 / 1 confirmations" with a hollow
  // ring until it confirms, then fills. (`reached` defaults to `done` for steps without a funding tx.)
  const steps = [
    { label: () => t("tlMatched"), done: !!v.htlc },
    { label: (d) => t(d ? "tlYouSent" : "tlYouSend", { coin: send }), done: fundBuried(v, fundLeg, myFund), reached: !!myFund, leg: fundLeg, txid: myFund?.txid, mem: myFund?.unconfirmed, fund: myFund },
    { label: (d) => t(d ? "tlCpSent" : "tlCpSend", { coin: recv }), done: fundBuried(v, claimLeg, cpFund), reached: !!cpFund, leg: claimLeg, txid: cpFund?.txid, mem: cpFund?.unconfirmed, fund: cpFund },
  ];
  if (refunded) steps.push({ label: () => t("tlRefunded", { coin: send }), done: !!myRefund, leg: fundLeg, txid: myRefund });
  else steps.push({ label: (d) => t(d ? "tlYouReceived" : "tlYouReceive", { coin: recv }), done: complete || !!myClaim, leg: claimLeg, txid: myClaim });
  let activeSet = false;
  return h("div", { class: "timeline" }, ...steps.map((s) => {
    const state = s.done ? "done" : (!activeSet && (activeSet = true) ? "active" : "todo");
    return h("div", { class: "tl-step " + state },
      h("span", { class: "tl-icon " + state }, s.done ? "✓" : ""),   // upcoming steps: a hollow ring (the border), no inner dot
      h("div", { class: "tl-body" },
        h("span", { class: "tl-label" }, s.label(s.reached ?? s.done)),
        s.txid ? h("span", { class: "tl-tx" }, s.mem ? h("span", { class: "tl-mem" }, t("tlMempool") + " · ") : null, txLink(s.leg, s.txid)) : null,
        s.fund ? ((c) => c ? h("span", { class: "tl-conf" }, c) : null)(confSub(v, s.leg, s.fund)) : null));
  }));
}

function renderLive(card, v) {
  while (card.firstChild) card.removeChild(card.firstChild);
  // Backfill deal details from the coordinator view (authoritative) — on a resume from a backup file
  // the amount screen was skipped, so flow.role/btcSats/qbtSats would otherwise be unset (→ "0 BTC").
  if (v.role && !flow.role) flow.role = v.role;
  if (flow.role && !flow.direction) flow.direction = dirForRole(flow.role);
  if (v.terms) { flow.btcSats = flow.btcSats || v.terms.btcSats || 0; flow.qbtSats = flow.qbtSats || v.terms.qbtSats || 0; }
  const { send, recv } = roleCoins();
  const fundLeg = coinLeg(send), funded = v.funding?.[fundLeg];
  const addr = v.htlc?.[fundLeg]?.address;
  const canceled = v.state === "CANCELED";
  const terminal = v.state === "COMPLETE" || v.state === "REFUNDED" || canceled;

  const headline = canceled ? t("swapCanceled")
    : v.state === "COMPLETE" ? t("swapComplete") : v.state === "REFUNDED" ? t("swapRefunded")
    : !addr ? t("waitingCounterparty")
    : funded ? t(funded.unconfirmed ? "coinPending" : "coinLocked", { coin: send }) : t("sendToLock", { coin: send });
  card.append(h("div", { style: "display:flex;justify-content:space-between;align-items:center" },
    h("h2", { style: "margin:0" }, headline),
    h("span", { class: "badge " + (STATE_CLASS[v.state] || "") }, v.state)));

  // Swap called off before anyone funded — show who cancelled and stop.
  if (canceled) {
    liveGuard = { risky: false };
    card.append(h("p", { class: "note", style: "margin-top:12px" }, v.canceled?.byYou ? t("cancelByYou") : t("cancelByCp")));
    return;
  }

  // While waiting for the counterparty, show the deal prominently.
  if (!terminal && !addr) {
    card.append(h("div", { style: "font-size:19px;font-weight:640;letter-spacing:-.01em;margin-top:14px;line-height:1.4" },
      t("sendingReceiving", { outAmt: `${sats(coinSats(send))} ${send}`, inAmt: `${sats(coinSats(recv))} ${recv}` }),
      " ",
      h("span", { class: "note", style: "font-weight:400;font-size:13px" }, t("minusFees"))));
  }

  if (v.securityError) { liveGuard = { risky: false }; card.append(h("p", { class: "note", style: "color:var(--bad);font-weight:600;margin-top:12px" }, t("securityErr"))); return; }

  if (!terminal) {
    // Three states: offline · online but still entering their details (present, no party data yet) · fully joined.
    const online = v.counterpartyOnline, joined = !!v.counterparty;
    card.append(h("div", { class: "note statusline", style: "margin-top:8px" },
      h("span", { class: `dot ${online ? "live" : "idle"}` }),
      !online ? t("cpOffline") : joined ? t("cpOnline") : t("cpEntering")));
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
  if (!terminal && flow.mode === "create" && flow.inviteLink) {
    card.append(h("div", { class: "btns", style: "margin-top:8px" }, copyButton("copyInvite", "inviteCopied", () => flow.inviteLink)));
  }
  // While waiting for the counterparty, let the creator go back to the share screen.
  if (!terminal && !addr && flow.mode === "create") {
    card.append(h("div", { style: "margin-top:14px" },
      h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); stepShare(); } }, t("back"))));
  }

  if (!terminal && addr) {
    card.append(h("div", { class: "fund" },
      h("div", { class: "muted" }, funded ? t(funded.unconfirmed ? "coinPendingCheck" : "coinLockedCheck", { coin: send }) : t("sendExactly", { coin: send })),
      h("div", { class: "amt" }, `${sats(coinSats(send))} ${send}`),
      funded ? null : h("div", { class: "mono", style: "margin-top:6px" }, addr),
      funded ? null : h("div", { class: "btns" }, copyButton("copyAddress", "copiedCheck", () => addr))));
  }

  // Persistent progress timeline (each step + its explorer tx link stays on the page, incl. after
  // completion). Its per-step "in mempool" tag surfaces 0-conf deposit detection on both legs.
  if (v.htlc) card.append(swapTimeline(v, send, recv));
  card.append(h("p", { class: "note" }, statusLine(v, send, recv)));
  if (!terminal && v.shortFunded) card.append(h("p", { class: "note", style: "color:var(--bad)" }, t("underfundWarn")));
  if (v.actionError) card.append(h("p", { class: "note", style: "color:var(--bad)" }, "⚠ " + v.actionError));
  // Either party can cancel while NOTHING is funded — clears stale swaps; the counterparty sees it.
  if (!terminal && !v.funding?.btc && !v.funding?.qbit) {
    card.append(h("div", { style: "margin-top:16px;text-align:center" },
      h("a", { href: "#", style: "color:var(--mut);font-size:13px", onclick: async (e) => {
        e.preventDefault(); if (!confirm(t("cancelConfirm"))) return;
        try { await flow.client.cancel(); } catch (err) { alert(err.message); }
      } }, t("cancelSwap"))));
  }
  // Keep the finished swap in the vault (marked done) rather than purging it, so reopening its link or
  // permalink resumes straight to this final status instead of the join flow. It's filtered out of the
  // "resume in-progress" list on the chooser.
  if (terminal && flow.client && !flow._doneSaved) { flow._doneSaved = true; vault.save({ ...flow.client.secrets(), done: true }).catch(() => {}); }
}
function statusLine(v, send, recv) {
  const amCreator = flow.mode !== "join";     // I created/shared the swap (drives the "waiting to be joined" copy)
  const amInitiator = flow.role === "alice";  // I hold the secret and claim first (the QBT buyer)
  if (!v.htlc) return amCreator ? t("stWaitJoin") : t("stSetup");
  switch (v.state) {
    case "COMPLETE": return t("stReceived", { amt: sats(coinSats(recv)), coin: recv });
    case "REFUNDED": return t("stReturned", { coin: send });
    case "CLAIMABLE": return amInitiator ? t("stBothFunded") : t("stWaitClaim");
    case "MATURING": return t("stMaturing");
    case "CLAIMED": return amInitiator ? t("stClaimed") : t("stPreimage");
    default: return v.funding?.[coinLeg(send)] ? t("stWaitFund") : t("stWaitDeposit");
  }
}

// ── resume from vault / backup ────────────────────────────────────────────────
function resumeSwap(secrets) {
  flow.role = secrets.role;                      // alice = QBT buyer/initiator, bob = QBT seller
  flow.direction = dirForRole(secrets.role);
  flow.mode = "join";                            // resume never re-shares (the invite link isn't in the backup)
  flow.coordinator = secrets.coordinator;
  flow.client = mkClient({ coordinator: secrets.coordinator }).restore(secrets);
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
  flow.client?.stop?.(); stopJoinHeartbeat();
  Object.assign(flow, { mode: null, role: null, direction: null, btcSats: 0, qbtSats: 0, receiveAddr: "", refundAddr: "", client: null, inviteLink: null, _recoverySaved: false });
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

// A fresh invite link pasted into an ALREADY-OPEN tab only changes the URL hash (no page reload), so
// the initial init() never sees it. Re-enter the flow on hashchange when the new hash is an invite.
window.addEventListener("hashchange", () => { const q = parseHash(); if (q.coord && q.id && q.token) init(); });
renderChrome();
init();
syncLangUrl();
