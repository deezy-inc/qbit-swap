# TODO

## ✅ DECIDED (2026-07-23): RFQ fees are taker-pays; peer link swaps keep buyer-pays

Danny's call: charge the platform fee to the **taker** in the retail-vs-market-maker (RFQ) setup —
the standard model everywhere (takers buy immediacy; charging makers just widens quoted spreads) —
and keep the existing buyer-pays structure for mutually-agreed link swaps.

**Implemented** (rfq.js `derive()` + swap.js `takerNetOfGross`/`feeTotalOn`; engine mechanics — the
fee output riding the BTC leg — untouched):
- RFQ **buy**: taker is the BTC sender, so the normal gross-up (`terms + fee` on top) already charges
  the taker; the maker receives `terms.btcSats` in full. Unchanged.
- RFQ **sell**: the quote nets the fee out of the taker's BTC proceeds
  (`terms.btcSats = takerNetOfGross(size × bid)`), so the maker's all-in outlay (`terms + fee`)
  equals exactly its quoted price × size. The widget discloses the net under the receive panel.
- Peer link swaps (and the flagged order book): buyer-pays, exactly as before.

Locked by `coordinator/rfq_fee.test.mjs`.
