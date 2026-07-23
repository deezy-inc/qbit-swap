// TRIAL RFQ market-maker bot — the reference implementation of the maker side of /rfq. Every few
// seconds it pings the coordinator with a two-sided quote (bid + ask around a mid price); the same
// ping's response delivers any matches (retail takes), which it fulfills by entering the swap as the
// assigned role and funding its leg from the regtest lab wallets:
//   · matched as BOB   (retail bought QBT): wait for the taker's BTC to bury (fundGate.cleared),
//     then fund the QBT leg — SwapClient auto-claims the BTC once the preimage is public.
//   · matched as ALICE (retail sold QBT): fund the BTC leg first (the initiator always funds first) —
//     SwapClient auto-claims the QBT (revealing the preimage) once both deposits mature.
// If this process stops, its quotes expire after RFQ_TTL_MS and the widget stops offering them — the
// liveness contract is the ping itself. Trial-only (lab wallets); a production maker follows the same
// loop with its own wallet + risk logic.
//   RFQ_MAKER_KEYS=mm-trial:trialkey node deploy/rfq-maker-trial.js   (coordinator needs the same key)
import { SwapClient } from "../src/swapflow.js";
import { qbit, btc } from "../../coordinator/chain.js";

const COORD = process.env.MAKER_COORD || "http://127.0.0.1:8787";
const KEY = process.env.MAKER_KEY || "trialkey";
const MID = Number(process.env.MAKER_MID || 0.2);          // BTC per QBT
const SPREAD = Number(process.env.MAKER_SPREAD || 0.05);   // 5% half-spread: bid = MID·(1-s), ask = MID·(1+s)
const SIZE = Number(process.env.MAKER_SIZE || 50e8);       // qbtSats quoted per side
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const handling = new Set();   // swapIds already being fulfilled (matches re-deliver until we join)

async function ping() {
  const r = await fetch(`${COORD}/rfq/maker`, {
    method: "POST", headers: { "content-type": "application/json", "x-maker-key": KEY },
    body: JSON.stringify({ bid: { price: MID * (1 - SPREAD), qbtSats: SIZE }, ask: { price: MID * (1 + SPREAD), qbtSats: SIZE } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j.matches || [];
}

async function fulfill(m) {
  const dests = { btcDest: await btc.rpcWallet("bob", "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet("bob", "getnewaddress") };
  let funded = false;
  const bot = new SwapClient({
    coordinator: COORD,
    onUpdate: async (v) => {
      const my = m.role === "alice" ? "btc" : "qbit";                       // the leg this bot funds
      const clear = m.role === "alice" ? !!v.htlc : v.fundGate?.cleared;    // alice funds first; bob only after the BTC buries
      if (!funded && v.htlc && clear && !v.funding?.[my]) {
        funded = true;
        const chain = my === "btc" ? btc : qbit;
        const amt = (my === "btc" ? v.terms.btcSats + (v.fee?.sats || 0) : v.terms.qbtSats) / 1e8;   // the BTC funder pre-pays the coordinator fee
        try { await chain.rpcWallet("bob", "sendtoaddress", v.htlc[my].address, amt); console.log(`  [rfq-maker] funded ${amt} ${my.toUpperCase()} for ${m.swapId.slice(0, 8)}`); }
        catch (e) { funded = false; console.log("  [rfq-maker] fund error:", e.message); }
      }
      if (v.state === "COMPLETE") console.log(`  [rfq-maker] ${m.swapId.slice(0, 8)} COMPLETE (${m.side} filled @ ${m.price})`);
    },
  });
  await bot.enter({ id: m.swapId, token: m.token, direction: "btc2qbt", role: m.role, ...dests });
  bot.start();
}

async function main() {
  for (const w of ["bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
  console.log(`[rfq-maker] quoting bid ${MID * (1 - SPREAD)} / ask ${MID * (1 + SPREAD)} BTC/QBT, ${SIZE / 1e8} QBT per side`);
  for (;;) {
    try {
      for (const m of await ping()) {
        if (handling.has(m.swapId)) continue;
        handling.add(m.swapId);
        console.log(`[rfq-maker] matched ${m.side} ${m.qbtSats / 1e8} QBT @ ${m.price} → swap ${m.swapId.slice(0, 8)} as ${m.role}`);
        fulfill(m).catch((e) => { console.log("  [rfq-maker] fulfill error:", e.message); handling.delete(m.swapId); });
      }
    } catch (e) { console.log("[rfq-maker] ping error:", e.message); }
    await sleep(5000);
  }
}
main().catch((e) => { console.error("rfq-maker-trial failed:", e.message); process.exit(1); });
