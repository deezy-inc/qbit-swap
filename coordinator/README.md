**English** · [简体中文](README.zh-CN.md)

# qbit-swap coordinator

A **keyless, non-custodial** service that orchestrates BTC↔QBT atomic swaps. It never holds keys,
funds, or the preimage (until it's public on-chain). It derives the two HTLC addresses, watches both
chains, gates the claim on reorg-safe confirmations (`getconfirmationtarget`), broadcasts
party-signed transactions, and surfaces the revealed preimage. Both the browser web app and a
headless market-maker **bot** drive it through the same HTTP API.

## Pieces
- `chain.js` — keyless chain adapter for both nodes (height, `getconfirmationtarget`, `scantxoutset`
  funding watch, confirmations, `testmempoolaccept`/`sendrawtransaction`). Dev transport shells to the
  regtest CLIs over ssh; a prod adapter swaps `rpc()` for direct JSON-RPC.
- `swap.js` — swap store + Tier-Nolan state machine
  (`CREATED→READY→BTC_FUNDED→QBT_FUNDED→MATURING→CLAIMABLE→CLAIMED→COMPLETE`, plus `REFUNDED`/`ABORTED`).
- `server.js` — HTTP/JSON API + a chain-watcher loop; auth via a per-party capability token.
- `admin.js` — **read-only monitoring dashboard** (see below).
- `demo.js` — two headless bots run a full swap through the API, signing client-side with `../js`.

## Admin dashboard (`admin.js`)
A separate in-process HTTP server (`startAdmin(port)`, default `8790`) that gives the operator a live
view of the store — overview counts, chain heights/backends, a filterable table of every swap (state,
amounts, funding, party presence, watchtower-armed status), the order book, and an SSE activity feed.
It reads the live in-memory store directly (no DB polling; global `subscribeAll` drives the feed),
exposes **no mutation endpoints**, and **redacts capability tokens**. Gated by `ADMIN_TOKEN`
(`?token=` or `X-Admin-Token`; a random one is generated + logged if unset). `serve.js`/`trial.js` start
it automatically unless `ADMIN=off`. It is meant to be reached over a private network (e.g. the tailnet),
never exposed publicly — bind with `ADMIN_BIND` and keep it off any public reverse proxy.
- `GET /` dashboard · `GET /api/overview` · `GET /api/swaps[?state=]` · `GET /api/swaps/:id` ·
  `GET /api/offers` · `GET /stream` (SSE)

## API (auth: `X-Swap-Token`, header or `?token=`)
- `POST /swaps` → `{ id, tokens: { alice, bob } }` (Alice shares Bob's token as his link)
- `POST /swaps/:id/party` — submit `{ qbitPub, btcPub, btcDest, qbitDest, H? }`
- `GET  /swaps/:id` — the party's view: both legs' HTLC addresses, funding (+`spent`), confs, chain
  `heights`, `state`, `refund` availability per leg, and `preimage` (only once public on-chain)
- `GET  /swaps/:id/events` — **Server-Sent Events**: the same view pushed on every state change (the
  web app and bots subscribe instead of polling)
- `POST /swaps/:id/broadcast` — submit `{ leg, kind, tx }` (`kind`: `claim` | `refund`) to broadcast
- `POST /swaps/:id/finish` — **watchtower**: submit a pre-signed `{ claim: { leg, needsPreimage, tiers:[{feerate,tx}] }, refund: { leg, tx } }` so the coordinator finishes the swap even if you go offline

The watcher surfaces `refund.{qbit,btc}.available` once a funded, still-unspent leg's timelock passes,
and flags a leg `spent` when its claim/refund lands (via the API or directly) — so a swap that
resolves out-of-band still reaches a terminal state.

## Watchtower (`swap.js` `driveWatchtower` + `fees.js`)
Once both legs are funded, each party pre-signs and uploads (`/finish`) a **fee-ladder claim** (several
feerate tiers) and a **refund**. The coordinator then drives the swap to completion or refund even if
both tabs close: it broadcasts the initiator's claim when the leg matures (revealing the preimage),
splices that preimage into the participant's pre-signed claim and broadcasts it, or broadcasts a party's
refund after its timelock on abort. It picks/escalates ladder tiers using cached mempool.space feerates
(`fees.js`, `FEES_TTL_MS`). **Non-custodial:** every stored tx pays only its owner's address and the
coordinator holds no keys — it can only help, never redirect. Full-RBF is the network default, so tiers
need no RBF signaling. Proven by `../webapp/test/watchtower.e2e.mjs` (both parties arm, close their
tabs, coordinator finishes).

## Order book API (optional — `offers.js`)
A maker/taker layer on top of the swap engine (the web app gates it behind a flag; see its README).
- `POST /offers` — maker posts one lot `{ giveCoin, giveSats, wantCoin, wantSats }` → `{ id, makerToken }`
- `GET  /offers` — public book: `{ asks, bids }` (QBT priced in BTC; ask = sell QBT for BTC), best price first
- `POST /offers/:id/take` — instantiate a swap from the offer (taker = initiator) → `{ swapId, takerToken, direction, terms }`
- `GET  /offers/:id?makerToken=…` — maker view incl. the take (its swap token) so it can fulfill
- `POST /offers/:id/cancel` (maker token) — withdraw an open offer

## Backends (env, per chain — see `chain.js`)
Each chain picks a backend via `<CHAIN>_BACKEND` (falls back to `COORD_CHAIN`, then `dev`):
- **`dev`** — shells to a node CLI. Set `<CHAIN>_CLI` and, to run remotely, `<CHAIN>_SSH_HOST`
  (empty = local). This is the regtest-lab transport; `findOutput` uses `scantxoutset` (fine only on a
  tiny regtest UTXO set).
- **`rpc`** — JSON-RPC over HTTP; set `<CHAIN>_RPC_URL` (e.g. `http://user:pass@host:port`). Funding
  watch method is per-chain via `<CHAIN>_WATCH` (default: BTC `wallet`, QBT `scan`):
  - `wallet` (Bitcoin default) — a **forward-only watch-only wallet** (`importdescriptors timestamp:"now"`
    + `listunspent`), never `scantxoutset`, so it works against a **pruned** Bitcoin node (`getTx` reads
    via the wallet, no `txindex`).
  - `scan` (Qbit default) — `scantxoutset`, which is cheap on a small UTXO set (Qbit's young chain) and
    avoids depending on wallet tracking of `p2mr` (witness-v2) descriptors. A full (unpruned) qbitd is
    cheap anyway since the whole chain is small.
  The wallet path runs a background job that rotates the wallet to drop settled swaps' descriptors so it
  can't balloon
  — **count-driven, not time-driven**: it only rotates once `WATCH_PRUNE_THRESHOLD` (default 500) stale
  descriptors have amortized (a few hundred is harmless), checked every `WATCH_CLEANUP_MS` (default 6h).
  A descriptor is kept while its swap is non-terminal (the **whole recovery/refund window**, which may be
  long) plus a `WATCH_SETTLE_GRACE_MS` grace after settling (default 24h), so it's never dropped while a
  counterparty might still be refunding. (Even if one were, funds are never at risk — the wallet is only
  for funding *detection*; parties refund with their own keys.) `WATCH_WALLET` sets the wallet name.
- **`esplora`** — mempool.space / self-hosted electrs REST for the **BTC leg** (no Bitcoin node needed);
  set `ESPLORA_URL` (default `https://mempool.space/api`). Indexed scripthash lookups + built-in
  rate-limit handling (`ESPLORA_MIN_INTERVAL_MS`, `ESPLORA_MAX_RETRIES`). This backend is BTC-only, so the
  QBT leg uses `dev`/`rpc` against your own `qbitd` (its data source — unrelated to how broadcastable QBT is).

Other knobs: `COORD_DB=/path/state.json` (JSON persistence; default in-memory) · `RATE_MAX=120`
(per-IP writes/min) · `DEV_CONFS_CAP` (cap the reorg-safe conf gate on hashrate-less regtest).

### HTLC addresses + timelocks (set these for the deploy network)
- `BTC_HRP` / `QBIT_HRP` — hrp for the HTLC **deposit addresses** the coordinator hands out. Must match
  the network: `bcrt`/`qbrt` (regtest, default), `tb`/`tqb` (testnet), `bc`/`qb` (mainnet). Wrong hrp =
  an address the user's wallet can't pay.
- **Timelocks are wall-clock**, not raw blocks. `HTLC_FROM_SECS` (initiator's leg, longer; default 24h)
  and `HTLC_TO_SECS` (participant's leg, shorter; default 12h) are each converted to a block count on
  their own chain via `BTC_BLOCK_SECS` (600) / `QBIT_BLOCK_SECS` (60). This keeps the Tier-Nolan
  ordering (initiator's leg outlasts the participant's, in real time) correct in **both** directions
  despite BTC's ~10 min vs QBT's ~60 s blocks. `HTLC_FROM_SECS` must exceed `HTLC_TO_SECS` (enforced).
  For a fast regtest lab, set the block times to `1` and the windows to `20`/`40` (see `deploy/lab.env`).

## Run the demos
Needs the two regtest nodes up (see `../wasm`/`../js`). Then:
```sh
DEV_CONFS_CAP=2 node demo.js         # happy path: full swap -> COMPLETE
DEV_CONFS_CAP=2 node refund_demo.js  # abort path: both parties refund -> REFUNDED, no preimage
```
`demo.js` creates a swap, both bots join, funds both HTLCs, matures the QBT leg, Alice claims QBT
(WASM SLH-DSA, revealing the preimage), Bob reads it and claims BTC. `refund_demo.js` funds both legs
then stalls; once the timelocks pass, Bob refunds his QBT and Alice refunds her BTC — proving the
non-custodial abort guarantee (nobody is left short).

## Not yet (next)
- The browser web app on top of `../js` (file backup + passkey-PRF/password-encrypted IndexedDB key
  management); reorg-aware height tracking already feeds the watcher.
