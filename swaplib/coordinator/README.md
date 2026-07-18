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
- `demo.js` — two headless bots run a full swap through the API, signing client-side with `../js`.

## API (auth: `X-Swap-Token`, header or `?token=`)
- `POST /swaps` → `{ id, tokens: { alice, bob } }` (Alice shares Bob's token as his link)
- `POST /swaps/:id/party` — submit `{ qbitPub, btcPub, btcDest, qbitDest, H? }`
- `GET  /swaps/:id` — the party's view: both legs' HTLC addresses, funding (+`spent`), confs, chain
  `heights`, `state`, `refund` availability per leg, and `preimage` (only once public on-chain)
- `GET  /swaps/:id/events` — **Server-Sent Events**: the same view pushed on every state change (the
  web app and bots subscribe instead of polling)
- `POST /swaps/:id/broadcast` — submit `{ leg, kind, tx }` (`kind`: `claim` | `refund`) to broadcast

The watcher surfaces `refund.{qbit,btc}.available` once a funded, still-unspent leg's timelock passes,
and flags a leg `spent` when its claim/refund lands (via the API or directly) — so a swap that
resolves out-of-band still reaches a terminal state.

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
  rate-limit handling (`ESPLORA_MIN_INTERVAL_MS`, `ESPLORA_MAX_RETRIES`). Qbit has no public backend, so
  the QBT leg must use `dev`/`rpc` against your own `qbitd`.

Other knobs: `COORD_DB=/path/state.json` (JSON persistence; default in-memory) · `RATE_MAX=120`
(per-IP writes/min) · `DEV_CONFS_CAP` (cap the reorg-safe conf gate on hashrate-less regtest).

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
