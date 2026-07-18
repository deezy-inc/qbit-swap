data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_key_pair" "app" {
  key_name_prefix = "qbit-swap-app-"
  public_key      = var.ssh_public_key
}

# No inbound is required: the Cloudflare Tunnel connector and Tailscale both dial OUT. SSH is opened
# only if you explicitly pass ssh_ingress_cidrs; otherwise reach the box over its tailnet IP.
resource "aws_security_group" "app" {
  name_prefix = "qbit-swap-app-"
  description = "qbit-swap app box: egress-only (cloudflared + tailscale dial out); optional SSH."

  dynamic "ingress" {
    for_each = length(var.ssh_ingress_cidrs) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_ingress_cidrs
    }
  }

  egress {
    description = "all outbound (tunnel, tailnet, package installs, mempool.space)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle { create_before_destroy = true }
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  key_name               = aws_key_pair.app.key_name
  vpc_security_group_ids = [aws_security_group.app.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    cloudflared_token  = var.cloudflared_token
    tailscale_authkey  = var.tailscale_authkey
    tailscale_hostname = var.tailscale_hostname
    repo_url           = var.repo_url
    git_ref            = var.git_ref
    github_token       = var.github_token
    public_url         = var.public_url
    network            = var.network
    btc_backend        = var.btc_backend
    btc_rpc_url        = var.btc_rpc_url
    esplora_url        = var.esplora_url
    btc_watch          = var.btc_watch
    qbit_rpc_url       = var.qbit_rpc_url
    qbit_watch         = var.qbit_watch
    orderbook          = var.orderbook ? "1" : ""
    admin_token        = var.admin_token
    admin_port         = var.admin_port
  })
  # Re-render + replace the instance when the wiring changes.
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.root_gb
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  tags = { Name = var.tailscale_hostname }
}
