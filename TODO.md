# TODO

## Discuss: who pays the platform fee on RFQ swaps — taker, maker, or split?

**Today's mechanics** (`swap.js` `deriveFee`): the platform fee (`FEE_BPS`, e.g. 2%) + network-fee
reserve is always charged **on top of the BTC leg**, paid by whoever sends BTC — i.e. the QBT *buyer*,
regardless of whether that party is the taker or the maker. Under the RFQ widget that means:

- retail **buys** QBT → the retail **taker** pays the 2% (they're the BTC sender) ✅ taker pays
- retail **sells** QBT → the **maker** pays the 2% (the maker is the BTC sender) ⚠️ maker pays

So the fee burden currently flips with direction — makers eat the fee on every retail sell, which
they'll simply price into a wider bid (retail pays it anyway, just invisibly and only on one side).

**What's standard**: on virtually every venue (CEXs, Uniswap-style AMMs, RFQ desks) the **taker pays**
— takers consume liquidity and pay for immediacy; makers provide liquidity and pay less, zero, or get
rebates. Maker-pays is rare because it directly widens quoted spreads. A maker/taker split (e.g.
taker 1.5% / maker 0.5%) exists on CEXs but mostly as a volume-tier device.

**Options**
1. **Taker always pays** (standard): charge the fee to whichever party took the quote, on the coin
   they send. Needs a small engine change — fee today is only collectible on the BTC leg (the fee
   output rides the BTC HTLC deposit); a QBT-side fee needs a QBT fee output or a BTC-equivalent
   gross-up on the taker's QBT deposit.
2. **Keep buyer-pays** (status quo): zero engine work; accept that makers price the sell-side fee
   into their bids (economically similar to taker-pays, less transparent, distorts displayed price
   competitiveness between sides).
3. **Split** (e.g. bps on each side): both parties gross up their deposit by their share. Most work,
   mostly useful later as a maker-incentive lever.

**Decide with Danny**: which model, and whether the RFQ widget should display the fee-inclusive
"all-in" price (probably yes either way).
