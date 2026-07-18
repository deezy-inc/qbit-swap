# qbit-swap web app

A **wallet-agnostic, non-custodial** browser app for BTC⇄QBT atomic swaps. The browser generates
ephemeral per-swap keys, signs its own claim/refund entirely in-page (WASM SLH-DSA for the Qbit leg,
ECDSA for the Bitcoin leg), and talks to a **keyless coordinator** that only relays and broadcasts.
The app never asks which wallet you use — you paste a receiving address of any type and send funds
from wherever you like.

## How it works
- The UI is a **one-decision-per-screen wizard**. The first screen is the only real choice — *which
  way do you want to swap?* — so **either side can initiate** (`btc2qbt` or `qbt2btc`).
- The creator is the **initiator** (holds the secret): funds the leg they send (longer timelock),
  claims the leg they receive (revealing the preimage). The joiner is the **participant**: funds the
  leg they send, claims the other with the now-public preimage.
- Each side enters only the addresses it needs (a receive address, and a refund address used only on
  cancel); the app decodes them to scriptPubKeys client-side (`addressToScriptPubKey` handles
  P2WPKH/P2WSH, P2TR, qbit P2MR, and legacy P2PKH/P2SH).
- The app drives the swap on the coordinator's live feed (SSE) and **auto-signs** claim/refund. If the
  swap stalls past the timelocks, each side auto-refunds its own deposit.
- **Watchtower safety net (default):** once both legs are funded, the app pre-signs a fee-ladder claim
  + a refund and uploads them, so the coordinator finishes (or refunds) the swap even if you close the
  tab. Until it's armed, the app warns you not to leave (`beforeunload`) — pays only to your addresses,
  non-custodial. Proven by `test/watchtower.e2e.mjs`.
- A **live presence indicator** shows whether your counterparty is online (from their SSE/API activity).
- UI is bilingual (**English / 简体中文**) via `src/i18n.js` — a header switcher, choice persisted.

## Order book (feature-flagged, default OFF)
There's an optional maker/taker **order book**: makers post offers, the landing shows the relevant side
for your chosen direction, and you click one to buy/sell (it takes the offer and runs the taker wizard).
It's gated behind `window.QBIT_ORDERBOOK` (default off) — with it off, choosing a direction goes
straight to the peer-to-peer flow, which is the primary experience. See `deploy/maker-trial.js` for a
regtest maker that posts asks + fulfills takes.

## Key protection (`src/keystore.js`)
For now (product decision) the ephemeral secrets are kept in the **clear**: a plaintext backup file
the user downloads, plus a plaintext IndexedDB copy so a reload can resume. One file protects one
short-lived swap; losing it can only lose that single swap (ephemeral keys, no shared seed), and a
stalled swap still refunds. Drop the file back into the app to finish or refund; the record is purged
on settle. *(An encrypted-envelope version — passphrase + WebAuthn-PRF passkey, `src/passkey.js` — is
preserved in git history and can be re-enabled for at-rest protection.)*

## Build & serve
```sh
npm install          # pulls @qbit-swap/client (file:../js)
npm run build        # -> dist/app.js (single self-contained module; WASM embedded, no external fetch)
python3 -m http.server 8080    # or any static server; open http://localhost:8080
```
The bundle targets the browser, so esbuild swaps the Node WASM signer for `signer.web.js` automatically.
Set the coordinator URL in the create form (or `window.QBIT_COORDINATOR`).

## Tests
- `npm test` — headless key-store round-trip (plaintext backup + vault save/list/purge).
- `DEV_CONFS_CAP=2 node test/bidir.e2e.mjs` (needs the regtest lab) — drives the real `SwapClient`
  through a full swap **in both directions** to COMPLETE against the live coordinator and chains.
- `TRIAL_URL=https://<host> node test/browser.e2e.mjs` (needs a running trial) — Playwright drives the
  actual wizard UI (creator + participant, both directions) through the faucet to COMPLETE.

## Security notes
- Keys never leave the browser; the coordinator is keyless and sees only public data (and the preimage
  only once it's on-chain).
- **HTLC verification:** before showing a deposit address, the client independently re-derives both
  HTLC scriptPubKeys from its own keys + the counterparty pubkey + `H` + locktimes and checks they match
  the coordinator's — a derivation bug (or tampering) that produced a script it can't claim/refund halts
  the swap before any funds move (`SwapClient.verifyHtlc`).
- **Address validation:** receive/refund addresses are checked to be a valid address *on the right chain*
  (`addressCoin`), so a BTC address can't be entered where a QBT one is needed (which would send funds to
  an unspendable cross-chain output).
- **Underfunding:** the coordinator only counts a leg as funded once the deposit meets the agreed amount,
  so a counterparty can't underfund their HTLC and short the other side.
- **Single-use link:** the first party to join a trade link claims the participant slot; a second person
  opening the same link is rejected rather than racing to replace them.
- One backup file protects one swap; losing it before settling can only ever lose that single swap
  (ephemeral keys, no shared seed) — and a stalled swap refunds. Backups are plaintext for now.
- **Not yet:** the counterparty's pubkey is currently taken on trust from the coordinator — a malicious
  coordinator could MITM the pubkey exchange. Mitigation (planned): an out-of-band SAS/fingerprint the
  two parties compare before funding. Also: timelocks are tuned per chain block-time before mainnet.
