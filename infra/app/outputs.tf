output "instance_id" {
  value = aws_instance.app.id
}

output "tailscale_hostname" {
  value       = var.tailscale_hostname
  description = "Reach the box at this name on your tailnet (SSH as ubuntu with the injected key)."
}

output "public_url" {
  value       = var.public_url
  description = "Point the Cloudflare Named Tunnel's public hostname here → http://127.0.0.1:8080."
}

output "admin_dashboard" {
  value       = "Over the tailnet: http://${var.tailscale_hostname}:${var.admin_port}/?token=<admin_token>  (read-only; NOT routed through the tunnel)"
  description = "The monitoring dashboard — reachable only from the tailnet, token-gated."
}

output "note" {
  value = "No inbound ports are open. Configure the CF tunnel route (dashboard) to http://127.0.0.1:8080 ONLY (never the admin port). Logs: journalctl -u qbit-swap -f ; init: /var/log/qbit-init.log"
}
