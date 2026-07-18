output "instance_id" {
  value = aws_instance.node.id
}

output "tailscale_hostname" {
  value = var.tailscale_hostname
}

output "qbit_rpc_url" {
  value       = "http://${var.rpc_user}:<rpc_password>@${var.tailscale_hostname}:${var.rpc_port}"
  description = "Set this (with the real password) as infra/app var qbit_rpc_url."
}

output "note" {
  value = "Keyless node (${var.disablewallet ? "-disablewallet" : "wallet enabled"}). RPC is tailnet-only. Logs: docker logs -f qbitd ; init: /var/log/qbit-node-init.log"
}
