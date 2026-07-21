// Layer-1 production monitor. Polls the coordinator's admin API (tailnet-only) and alerts to Telegram
// on anything that could cost a customer funds. Deterministic, read-only, no LLM — it's the safety net
// that must fire reliably. The coordinator's watchtower is the automated ACTOR (claims/refunds for
// offline parties); this watches whether the watchtower + nodes are healthy enough to do their job, and
// pages a human when a swap's own risk flags (from admin.js riskOf) persist longer than the watchtower
// should need.
//
// Run on the swap-server box via cron (every ~2 min):
//   */2 * * * * set -a; . /home/ubuntu/qbit-monitor.env; set +a; /usr/bin/node /home/ubuntu/qbit-otc/coordinator/monitor.js >> /home/ubuntu/qbit-monitor.log 2>&1
// Env: ADMIN_URL (default http://127.0.0.1:8790) · ADMIN_TOKEN · TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID ·
//      MONITOR_STATE (state file) · GRACE_MIN · STALL_MIN · STUCK_HOURS · RE_ALERT_MIN · HEARTBEAT_HOURS
import { readFileSync, writeFileSync } from "node:fs";

const ADMIN = (process.env.ADMIN_URL || "http://127.0.0.1:8790").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN || "";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "", TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const STATE_PATH = process.env.MONITOR_STATE || "/home/ubuntu/qbit-monitor-state.json";
const GRACE_MIN = Number(process.env.GRACE_MIN || 10);        // let the watchtower act before paging on a swap risk flag
const STALL_MIN = Number(process.env.STALL_MIN || 20);        // a chain height stuck this long = node problem
const STUCK_HOURS = Number(process.env.STUCK_HOURS || 6);     // active + funded, this old, still not settled
const RE_ALERT_MIN = Number(process.env.RE_ALERT_MIN || 30);  // re-page a still-active issue this often
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS || 24);  // periodic "all clear" (0 = off)
const now = Date.now();

const short = (id) => (id || "").slice(0, 10);
const fmtAmt = (s) => `${(s.btcSats || 0) / 1e8} BTC ⇄ ${(s.qbtSats || 0) / 1e8} QBT`;
const mins = (ms) => Math.round(ms / 60000);
const stEmoji = (st) => ({ CREATED: "🆕", READY: "🤝", FROM_FUNDED: "💰", TO_FUNDED: "💰", MATURING: "⏳", CLAIMABLE: "🔓", CLAIMED: "🔑", COMPLETE: "✅", REFUNDED: "↩️", CANCELED: "🚫", ABORTED: "⚠️" }[st] || "🔄");

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.error("[no telegram]", text.replace(/<[^>]+>/g, "")); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.error("telegram send failed", r.status, await r.text().catch(() => ""));
  } catch (e) { console.error("telegram error", e.message); }
}
const api = async (p) => {
  const r = await fetch(`${ADMIN}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const loadState = () => { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; } };
const saveState = (s) => { try { writeFileSync(STATE_PATH, JSON.stringify(s)); } catch (e) { console.error("state write failed", e.message); } };

// Page for an issue, honoring a grace period (for self-healing risk flags) and a re-alert cooldown.
async function maybeAlert(state, i) {
  const a = (state.alerts[i.key] ||= { firstSeen: now, lastSent: 0 });
  if (i.grace && now - a.firstSeen < GRACE_MIN * 60000) return;   // give the watchtower / a returning user time
  if (now - a.lastSent < RE_ALERT_MIN * 60000) return;           // don't spam a known issue
  await tg(`<b>[${i.sev}]</b> ${i.msg}`);
  a.lastSent = now;
}

async function main() {
  const state = loadState();
  state.alerts ||= {}; state.heights ||= {}; state.heightsAt ||= {};
  const firstRun = !state.swapStates; state.swapStates ||= {};   // first run records a baseline (no backlog flood)

  const issues = [];   // { key, sev, msg, grace? }

  let ov;
  try { ov = await api("/api/overview"); }
  catch (e) {
    // The admin API itself is our only visibility — if it's unreachable, that's the top alarm.
    await maybeAlert(state, { key: "admin-unreachable", sev: "CRITICAL", msg: `⛔ Coordinator admin API unreachable: ${e.message}` });
    saveState(state); return;
  }
  if (state.alerts["admin-unreachable"]) { await tg("✅ Coordinator admin API reachable again"); delete state.alerts["admin-unreachable"]; }

  // Node connectivity (both legs) + chain-height stall (QBT only). Bitcoin routinely goes >20 min
  // between blocks — that's expected variance, not a fault — so a height-stall alert on BTC is pure
  // noise; we track its height but never page on the gap. QBT targets ~75s blocks, so a stall there
  // is a genuine node problem worth an alert. Node-UNREACHABLE still alerts on both legs.
  for (const leg of ["btc", "qbit"]) {
    const c = ov.chains?.[leg];
    if (!c?.ok) { issues.push({ key: `node-down-${leg}`, sev: "CRITICAL", msg: `⛔ ${leg.toUpperCase()} node unreachable (${c?.backend}): ${c?.error || "no height"}` }); continue; }
    const prev = state.heights[leg], prevAt = state.heightsAt[leg] || now;
    if (leg === "qbit" && prev != null && c.height === prev && now - prevAt > STALL_MIN * 60000)
      issues.push({ key: `stall-${leg}`, sev: "CRITICAL", msg: `⛔ QBT height stuck at ${c.height} for ${mins(now - prevAt)} min` });
    if (prev == null || c.height !== prev) { state.heights[leg] = c.height; state.heightsAt[leg] = now; }
  }

  const swaps = await api("/api/swaps");

  // Ping on every swap STATE CHANGE — created, → funding, → claimable, → claimed, → complete, refunded, etc.
  // The state file holds each swap's last-seen state across runs; the first run just records a baseline so we
  // don't replay the whole backlog. Informational, so it's sent immediately (no grace / cooldown).
  {
    const live = new Set();
    for (const s of swaps) {
      live.add(s.id);
      const prev = state.swapStates[s.id];
      if (!firstRun && prev !== s.state)
        await tg(prev === undefined
          ? `${stEmoji(s.state)} New swap <code>${short(s.id)}</code> · ${fmtAmt(s)} · <b>${s.state}</b>`
          : `${stEmoji(s.state)} Swap <code>${short(s.id)}</code> · ${fmtAmt(s)}: ${prev} → <b>${s.state}</b>`);
      state.swapStates[s.id] = s.state;
    }
    for (const id of Object.keys(state.swapStates)) if (!live.has(id)) delete state.swapStates[id];   // forget pruned swaps
  }

  // Per-swap risk. riskOf() flags a funded leg past its timelock, an unprotected (offline, un-armed)
  // deposit, or a public preimage the participant hasn't claimed — the actual fund-loss conditions.
  for (const s of swaps) {
    for (const flag of (s.risk || []))
      issues.push({ key: `risk:${s.id}:${flag}`, sev: "CRITICAL", grace: true, msg: `⚠️ Swap <code>${short(s.id)}</code> (${fmtAmt(s)}): ${flag}` });
    // Underfunded deposit — but only while it's still there. A refund spends the short UTXO
    // (shortFunded[leg].spent → true) and moves the swap to REFUNDED; once that happens this drops out
    // of the issue set and the resolve pass announces it cleared, so a refunded short stops pinging.
    const shortOpen = s.short && Object.values(s.short).some((sf) => sf && !sf.spent) && !["REFUNDED", "ABORTED", "CANCELED", "COMPLETE"].includes(s.state);
    if (shortOpen)
      issues.push({ key: `short:${s.id}`, sev: "WARN", msg: `⚠️ Swap <code>${short(s.id)}</code> underfunded: got ${JSON.stringify(s.short)}` });
    const active = !["COMPLETE", "REFUNDED", "ABORTED", "CANCELED", "CREATED"].includes(s.state);
    if (active && (s.funded?.btc || s.funded?.qbit) && s.createdAt && now - s.createdAt > STUCK_HOURS * 3600000)
      issues.push({ key: `stuck:${s.id}`, sev: "WARN", msg: `⚠️ Swap <code>${short(s.id)}</code> funded but ${s.state} for ${Math.round((now - s.createdAt) / 3600000)}h` });
  }

  // Fire new/re-due issues; announce ones that have cleared.
  const seen = new Set(issues.map((i) => i.key));
  for (const i of issues) await maybeAlert(state, i);
  for (const key of Object.keys(state.alerts)) {
    if (key === "admin-unreachable" || key === "_heartbeat") continue;
    if (!seen.has(key)) { await tg(`✅ Resolved: <code>${key}</code>`); delete state.alerts[key]; }
  }

  // Optional periodic "all clear" so silence-because-broken is distinguishable from silence-because-fine.
  if (HEARTBEAT_HOURS > 0) {
    const hb = state.alerts._heartbeat || { lastSent: 0 };
    if (now - hb.lastSent > HEARTBEAT_HOURS * 3600000) {
      await tg(`✅ qbitswap monitor OK · ${ov.totals?.active || 0} active · ${ov.totals?.complete || 0} complete · BTC h${ov.chains?.btc?.height} · QBT h${ov.chains?.qbit?.height}`);
      state.alerts._heartbeat = { lastSent: now };
    }
  }

  saveState(state);
  console.log(`[monitor] ${new Date(now).toISOString()} — ${issues.length} issue(s), ${swaps.length} swap(s)`);
}

main().catch((e) => { console.error("monitor error", e.message); process.exit(1); });
