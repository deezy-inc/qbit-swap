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

output "note" {
  value = "No inbound ports are open. Configure the CF tunnel route (dashboard) to http://127.0.0.1:8080. Logs: journalctl -u qbit-swap -f ; init: /var/log/qbit-init.log"
}
