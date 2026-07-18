variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type        = string
  description = "Local AWS CLI profile to use."
  default     = "claude-sandbox"
}

variable "tags" {
  type    = map(string)
  default = { Owner = "claude-sandbox", Project = "qbit-swap" }
}

variable "instance_type" {
  type        = string
  description = "App + coordinator is light (Node + cloudflared + tailscale). 2 GB is plenty."
  default     = "t3.small"
}

variable "root_gb" {
  type    = number
  default = 20
}

variable "ssh_public_key" {
  type        = string
  description = "Public key injected for SSH. Reach the box over the tailnet (no public SSH by default)."
}

variable "ssh_ingress_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to SSH on :22. Default [] = no public SSH; use the tailnet IP + the injected key."
  default     = []
}

# ── Front door: Cloudflare Tunnel (egress-only; no inbound ports on the box) ──────────────────
variable "cloudflared_token" {
  type        = string
  description = "Connector token for a Cloudflare Named Tunnel (route it to http://127.0.0.1:8080 in the CF dashboard)."
  sensitive   = true
}

# ── Tailnet: how the coordinator reaches the chain nodes ──────────────────────────────────────
variable "tailscale_authkey" {
  type        = string
  description = "Tailscale auth key (reusable/ephemeral). The box joins the tailnet to reach the node RPCs."
  sensitive   = true
}

variable "tailscale_hostname" {
  type    = string
  default = "qbit-swap-app"
}

# ── App source ────────────────────────────────────────────────────────────────────────────────
variable "repo_url" {
  type        = string
  description = "Public clone URL. Private clone uses github_token below instead."
  default     = "https://github.com/deezy-inc/qbit-swap.git"
}

variable "git_ref" {
  type    = string
  default = "main"
}

variable "github_token" {
  type        = string
  description = "Optional PAT to clone the repo while it is still private. Empty = clone repo_url anonymously."
  sensitive   = true
  default     = ""
}

# ── Runtime wiring (becomes /etc/qbit-swap.env) ──────────────────────────────────────────────
variable "public_url" {
  type        = string
  description = "The public HTTPS origin the tunnel maps to, e.g. https://swap.example.com. Injected as window.QBIT_COORDINATOR = <public_url>/coord."
}

variable "network" {
  type        = string
  description = "regtest | testnet | mainnet — selects the address HRPS the app enforces and the qbitd it should point at."
  default     = "testnet"
  validation {
    condition     = contains(["regtest", "testnet", "mainnet"], var.network)
    error_message = "network must be regtest, testnet, or mainnet."
  }
}

variable "btc_backend" {
  type        = string
  description = "rpc (own/prune node) or esplora (mempool.space / self-hosted electrs)."
  default     = "esplora"
}

variable "btc_rpc_url" {
  type        = string
  description = "http://user:pass@<btc-host>:8332 over the tailnet (only used when btc_backend = rpc)."
  sensitive   = true
  default     = ""
}

variable "esplora_url" {
  type        = string
  description = "Used when btc_backend = esplora."
  default     = "https://mempool.space/api"
}

variable "btc_watch" {
  type    = string
  default = "wallet" # pruned-node-safe watch-only wallet
}

variable "qbit_rpc_url" {
  type        = string
  description = "http://user:pass@<qbit-host>:<port> — the DEDICATED, keyless swap qbitd (never the mainnet-wallet box)."
  sensitive   = true
}

variable "qbit_watch" {
  type    = string
  default = "scan" # scantxoutset — no wallet needed on the qbit node
}

variable "orderbook" {
  type        = bool
  description = "Enable the maker/taker order book UI (default off = peer-to-peer only)."
  default     = false
}

# ── Admin dashboard (tailnet-only; NOT routed through the Cloudflare Tunnel) ──────────────────
variable "admin_token" {
  type        = string
  description = "Token gating the read-only admin dashboard. Reach it over the tailnet at http://<host>:<admin_port>/?token=<this>."
  sensitive   = true
}

variable "admin_port" {
  type    = number
  default = 8790
}
