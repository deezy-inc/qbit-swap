# qbit-swap

Non-custodial atomic swaps between **Bitcoin (BTC)** and **Qbit (QBT)** — a post-quantum Bitcoin fork
(SLH-DSA signatures, `p2mr` witness-v2 addresses). Users trade peer-to-peer through a **keyless
coordinator**: all keys are ephemeral and generated in the user's browser, all signing happens
client-side, and the coordinator only watches the chains and relays party-signed transactions. It can
never move or lose funds; a stalled swap always refunds.

> Bitcoin ↔ Qbit can't use a shared-Schnorr construction (Qbit signs with SLH-DSA, not Schnorr), so
> this uses a classic hash-timelock (Tier-Nolan) atomic swap: one preimage links both legs.

## Repository layout

| Path | What it is | Public |
|---|---|---|
| `swaplib/js/` | **Client library** (`@qbit-swap/client`) — HTLC construction + sighash + signing for both legs; browser + Node. WASM SLH-DSA signer bundled. | ✅ |
| `swaplib/coordinator/` | **Keyless coordinator** — Tier-Nolan state machine, reorg-safe confirmation gating, refund side-paths, SSE live feed, presence, pluggable chain backends. | ✅ |
| `swaplib/webapp/` | **Web app** — a wallet-agnostic, one-decision-per-screen wizard (EN / 简体中文). Ephemeral keys, in-page signing, plaintext backup file. | ✅ |
| `swaplib/*.py` | Python reference implementation + regtest validation scripts. | ✅ |
| `node-patches/` | Upstream PR for `qbitd`: partially-sign non-template `p2mr` leaves (lets a Qbit wallet sign HTLCs). | ✅ |

Market-maker bots live in a **separate private repo** (they consume `@qbit-swap/client` + the
coordinator API).

## How a swap works

1. Either side opens the web app and picks a direction (BTC→QBT or QBT→BTC). The **initiator** holds a
   secret `s` with `H = SHA256(s)`.
2. Both legs are funded to HTLC addresses derived from `H` and the two parties' pubkeys. The
   initiator funds the leg it sends (longer timelock); the participant funds the other (shorter).
3. The initiator claims the leg it receives, revealing `s` on-chain. The participant reads `s` and
   claims the other leg. If either side stalls past the timelocks, each refunds its own deposit.

The coordinator gates the initiator's claim on **reorg-safe confirmations** via Qbit's
`getconfirmationtarget` RPC, and surfaces the preimage + refundability over an SSE feed.

The default experience is **peer-to-peer** (share a private link with a counterparty). An optional
maker/taker **order book** — makers post offers, takers click to buy/sell — exists behind a web-app
feature flag (`window.QBIT_ORDERBOOK`, default off) with coordinator support in `offers.js`.

## Backends (what infrastructure you need)

The coordinator only does chain **reads + broadcast** (it's keyless). Each chain picks a backend via
env — see `swaplib/coordinator/chain.js`:

- **Qbit — required: your own `qbitd`.** There's no public Qbit backend, and the reorg-safe conf gate
  is a `qbitd` RPC. Use `QBIT_BACKEND=rpc` + `QBIT_RPC_URL=...`.
- **Bitcoin — three options:**

  | `BTC_BACKEND` | Node | Disk | Rough $/mo (AWS) | Notes |
  |---|---|---|---|---|
  | `rpc` (watch-only wallet) | **pruned** Bitcoin Core | ~30–50 GB | **~$110–180** | cheapest; forward-only address watching; never uses `scantxoutset` |
  | `esplora` → `mempool.space` | none | 0 | **$0** | fastest to start; rate-limited + leaks watched addresses |
  | `esplora` → self-hosted electrs | **full** Core + electrs | ~2 TB | ~$265–450 | richest; heaviest (esplora REST index is large) |

  The `esplora` backend includes rate-limit handling (min-interval throttle + 429/5xx backoff) and
  works against any Esplora REST endpoint (`ESPLORA_URL`). The `rpc` backend uses a **watch-only
  wallet** (import each HTLC address forward-only) — never `scantxoutset`, which rescans the whole
  UTXO set and is unusable on mainnet.

  **Recommended:** start on `mempool.space` (free), move to a **pruned node + `rpc`** for cost, or
  self-host electrs if you want the REST API with no third party. Keep the node box **private**,
  separate from the public coordinator (which is the attack surface).

## Running it (regtest)

Each component has its own README:
- `swaplib/js/README.md` — client library + browser/Node signer, tests.
- `swaplib/coordinator/README.md` — API, state machine, backends, demos (`demo.js`, `refund_demo.js`).
- `swaplib/webapp/README.md` — build the app, run the wizard e2e, the trial deployment.

A local regtest lab drives the transport via env (`<CHAIN>_CLI`, optional `<CHAIN>_SSH_HOST`); no
hostnames are baked into the code.

## License

MIT — see [LICENSE](LICENSE).
