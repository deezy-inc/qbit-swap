data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_key_pair" "node" {
  key_name_prefix = "swap-node-"
  public_key      = var.ssh_public_key
}

# RPC is reached only over the tailnet (qbitd -rpcallowip is the tailnet CGNAT range). No public
# inbound — Tailscale dials out. SSH only if you pass ssh_ingress_cidrs.
resource "aws_security_group" "node" {
  name_prefix = "swap-node-"
  description = "Dedicated keyless swap qbitd: egress-only + tailnet RPC; optional SSH."

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
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle { create_before_destroy = true }
}

resource "aws_instance" "node" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  key_name               = aws_key_pair.node.key_name
  vpc_security_group_ids = [aws_security_group.node.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    tailscale_authkey  = var.tailscale_authkey
    tailscale_hostname = var.tailscale_hostname
    qbitd_image        = var.qbitd_image
    qbitd_bin          = var.qbitd_bin
    qbitd_chain_arg    = var.qbitd_chain_arg
    rpc_user           = var.rpc_user
    rpc_password       = var.rpc_password
    rpc_port           = var.rpc_port
    disablewallet      = var.disablewallet ? "-disablewallet" : ""
    qbitd_extra_args   = var.qbitd_extra_args
  })
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.root_gb
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tags = { Name = var.tailscale_hostname }
}
