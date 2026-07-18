# infra — qbit-swap deployment (Terraform)

Two independent Terraform stacks that stand up the public swap service on AWS. Nothing here is applied
automatically — review, `plan`, then `apply`.

```
                 Cloudflare Tunnel  (public HTTPS, egress-only connector)
                         │
                         ▼
   infra/app ──▶ [ app box ]  web app + KEYLESS coordinator  (serve.js, no inbound ports)
                         │  joins the tailnet
        ┌────────────────┼─────────────────────────────┐
        ▼                                               ▼
 infra/qbit-node ─▶ [ swap qbitd ]                 [ BTC node ]
   keyless, -disablewallet, tailnet-only RPC       existing prune box  OR  esplora (mempool.space)
```

## Why the pieces are split

- **The coordinator is keyless.** It only watches the chains (`scantxoutset` / watch-only wallet),
  reads reorg-safe confirmations (`getconfirmationtarget`), and broadcasts party-signed transactions.
  It holds no keys and moves no funds. So the app box is safe to expose to the internet.
- **A dedicated swap qbitd, separate from the mainnet-wallet node.** The swap node runs
  `-disablewallet` — no keys, no funds — and is the *only* qbitd the public coordinator can reach. Your
  mainnet-wallet box is never in the blast radius. (`QBIT_WATCH=scan` means the coordinator needs
  nothing more than a node.)
- **No public inbound anywhere.** Both boxes' security groups open no ports (SSH optional). The
  Cloudflare Tunnel connector and Tailscale both dial *out*; RPC is reached only over the tailnet
  (`-rpcallowip=100.64.0.0/10`).

## Apply order

1. **`infra/qbit-node`** — bring up the keyless swap qbitd; let it sync. Note its tailnet name + RPC
   port → that's the app's `qbit_rpc_url`.
2. **BTC** — either reuse the existing prune box (`btc_backend = "rpc"`, `btc_rpc_url = ...`) or use
   `btc_backend = "esplora"` (no node).
3. **`infra/app`** — set `qbit_rpc_url`, the BTC backend, `public_url`, `cloudflared_token`,
   `tailscale_authkey`, then `apply`.
4. In the **Cloudflare dashboard**, route the tunnel's public hostname → `http://127.0.0.1:8080`.

```sh
cd infra/qbit-node && cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars
terraform init && terraform apply
cd ../app        && cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars
terraform init && terraform apply
```

## Networks

`network` selects the address HRPS the app enforces (`regtest→bcrt/qbrt`, `testnet→tb/tqb`,
`mainnet→bc/qb`) — a wrong-network address is rejected client-side. Stage on **testnet** before
mainnet. The coordinator's timelocks still need wall-clock tuning per chain before mainnet
(see `swaplib/webapp/README.md` › Trust assumptions).

## Secrets

Auth keys, RPC passwords, and the tunnel/github tokens are passed as Terraform variables and end up in
**TF state** and **EC2 user-data**. Keep state private (S3 backend with encryption, or local + gitignored).
Moving these to SSM Parameter Store / Secrets Manager is a reasonable follow-up. `.tfvars` and state are
gitignored (`infra/.gitignore`).

## Admin dashboard (tailnet-only)

The app box also runs a **read-only monitoring dashboard** in the coordinator process
(`swaplib/coordinator/admin.js`). It's a live window into the swap store: overview counts, chain
heights/backends, a filterable table of every swap (state, amounts, funding, party presence,
watchtower-armed status), the order book, and an SSE activity feed. It reads the live in-memory store
directly (no DB polling) and exposes **no mutation endpoints**; capability tokens are redacted.

It is **not** routed through the Cloudflare Tunnel — reach it over the tailnet:

```
http://<tailscale_hostname>:8790/?token=<admin_token>
```

The port opens no public inbound (the security group stays closed); only tailnet peers reach it, and
the `admin_token` gates every API/SSE call. Set the tunnel route to `:8080` **only** — never `:8790`.

## Operating

- App: `journalctl -u qbit-swap -f`  ·  init log `/var/log/qbit-init.log`  ·  health `curl -s http://127.0.0.1:8080/healthz`
- Dashboard: `http://<host>:8790/?token=<admin_token>` over the tailnet
- Node: `docker logs -f qbitd`  ·  init log `/var/log/qbit-node-init.log`
- SSH: over the tailnet as `ubuntu` with the injected key (no public SSH unless you set `ssh_ingress_cidrs`).
