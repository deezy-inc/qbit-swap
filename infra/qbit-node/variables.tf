variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type    = string
  default = "claude-sandbox"
}

variable "tags" {
  type    = map(string)
  default = { Owner = "claude-sandbox", Project = "qbit-swap" }
}

variable "instance_type" {
  type        = string
  description = "Qbit's chain is small; a full (unpruned) node is cheap. Bump if IBD/validation needs it."
  default     = "t3.medium"
}

variable "root_gb" {
  type    = number
  default = 40
}

variable "ssh_public_key" {
  type = string
}

variable "ssh_ingress_cidrs" {
  type        = list(string)
  description = "Default [] = no public SSH; reach it over the tailnet."
  default     = []
}

variable "tailscale_authkey" {
  type      = string
  sensitive = true
}

variable "tailscale_hostname" {
  type    = string
  default = "swap-node"
}

# ── qbitd ───────────────────────────────────────────────────────────────────────────────────────
variable "qbitd_image" {
  type        = string
  description = "Docker image with a STOCK qbitd/qbit-cli build. The p2mr signing patch (node-patches/) is NOT needed — the keyless coordinator only uses scantxoutset, getconfirmationtarget, and broadcast. Empty = cloud-init installs Docker but does NOT start qbitd (finish by hand)."
  default     = ""
}

variable "qbitd_bin" {
  type    = string
  default = "/src/build/bin/qbitd"
}

variable "qbit_cli_bin" {
  type    = string
  default = "/src/build/bin/qbit-cli"
}

variable "qbitd_chain_arg" {
  type        = string
  description = "Chain flag: -regtest | -testnet4 | (empty for mainnet)."
  default     = "-testnet4"
}

variable "rpc_user" {
  type    = string
  default = "lab"
}

variable "rpc_password" {
  type      = string
  sensitive = true
}

variable "rpc_port" {
  type    = number
  default = 18332
}

variable "disablewallet" {
  type        = bool
  description = "Run qbitd with -disablewallet: the swap node is keyless (scantxoutset only), so it holds NO wallet and NO funds — the whole point of a node separate from your mainnet wallet."
  default     = true
}

variable "qbitd_extra_args" {
  type    = string
  default = ""
}
