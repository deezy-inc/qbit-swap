// TRIAL market maker: posts a few QBT-for-BTC asks to the coordinator's order book and fulfills any
// that get taken (enters as the participant, funds its QBT leg from the regtest lab once the taker's
// BTC lands, and lets the SwapClient auto-claim the BTC). Keeps the book replenished. Trial-only — it
// funds from throwaway lab wallets. Run alongside deploy/trial.js.  node deploy/maker-trial.js
import { SwapClient } from "../src/swapflow.js";
import { qbit, btc } from "../../coordinator/chain.js";

const COORD = process.env.MAKER_COORD || "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(COORD + p, { method: o.m || "GET", headers: { "content-type": "application/json" }, body: o.b ? JSON.stringify(o.b) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };

// lot sizes as [QBT to sell, BTC wanted]  (price = BTC/QBT)
const LOTS = [[100000000, 20000000], [500000000, 100000000], [1000000000, 205000000], [2500000000, 500000000]];
const offers = new Map();   // offerId -> { makerToken, lot, handling }

async function postAsk(lot) {
  const [giveQbt, wantBtc] = lot;
  const o = await api("/offers", { m: "POST", b: { giveCoin: "QBT", giveSats: giveQbt, wantCoin: "BTC", wantSats: wantBtc } });
  offers.set(o.id, { makerToken: o.makerToken, lot, handling: false });
  return o.id;
}

async function fulfill(swapId, makerSwapToken, makerRole = "bob") {
  const dests = { btcDest: await btc.rpcWallet("bob", "getnewaddress", "", "bech32"), qbitDest: await qbit.rpcWallet("bob", "getnewaddress") };
  let funded = false;
  const maker = new SwapClient({
    coordinator: COORD,
    onUpdate: async (v) => {
      // Tier-Nolan safety: only lock QBT once the taker's BTC HTLC is on-chain.
      if (!funded && v.htlc && v.funding?.btc && !v.funding?.qbit) {
        funded = true;
        try { await qbit.rpcWallet("bob", "sendtoaddress", v.htlc.qbit.address, v.terms.qbtSats / 1e8); console.log(`  [maker] funded QBT ${v.terms.qbtSats / 1e8} for swap ${swapId.slice(0, 8)}`); }
        catch (e) { funded = false; console.log("  [maker] fund error:", e.message); }
      }
      if (v.state === "COMPLETE") console.log(`  [maker] swap ${swapId.slice(0, 8)} COMPLETE — sold QBT for BTC`);
    },
  });
  await maker.enter({ id: swapId, token: makerSwapToken, direction: "btc2qbt", role: makerRole, ...dests });
  maker.start();
}

async function ensureWallets() {
  for (const w of ["bob"]) { try { await qbit.rpc("loadwallet", w); } catch {} try { await btc.rpc("loadwallet", w); } catch {} }
}

async function main() {
  await ensureWallets();
  for (const lot of LOTS) await postAsk(lot);
  console.log(`[maker] posted ${LOTS.length} asks; watching for takes…`);
  for (;;) {
    for (const [id, o] of [...offers]) {
      try {
        const mv = await api(`/offers/${id}?makerToken=${o.makerToken}`);
        if (mv.status === "taken" && mv.take && !o.handling) {
          o.handling = true;
          console.log(`[maker] ask ${id.slice(0, 8)} taken -> fulfilling swap ${mv.take.swapId.slice(0, 8)}`);
          await fulfill(mv.take.swapId, mv.take.makerSwapToken, mv.take.makerRole);
          offers.delete(id);
          await postAsk(o.lot);   // replenish the book with a fresh ask of the same lot
        }
      } catch { /* transient */ }
    }
    await sleep(3000);
  }
}
main().catch((e) => { console.error("maker-trial failed:", e.message); process.exit(1); });
