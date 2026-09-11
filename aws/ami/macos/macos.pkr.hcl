locals {
  timestamp = regex_replace(timestamp(), "[- TZ:]", "")
  ami_name  = "pytorch-ci-macos-${var.macos_version}-arm64-${local.timestamp}"
}

# Apple Silicon only. A single arm64_mac AMI is portable across every Mac2
# instance family (mac2 / mac2-m2 / mac2-m2pro / mac2-m4*), so there is no
# need for a per-chip variant. If x86_64 Intel Macs are ever needed, fork
# this template rather than re-parameterizing.
data "amazon-ami" "macos_root_ami" {
  filters = {
    name                = "amzn-ec2-macos-${var.macos_version}*-arm64"
    architecture        = "arm64_mac"
    virtualization-type = "hvm"
    root-device-type    = "ebs"
  }
  most_recent = true
  owners      = ["amazon"]
  region      = var.region
}

source "amazon-ebs" "macos_builder" {
  ami_name                    = local.ami_name
  # Note: Mac AMI root snapshots are encrypted by default, and AWS rejects
  # ModifyImageAttribute(launchPermission=all) on encrypted snapshots. We keep
  # the AMI private-to-account, which is what the pytorch-gha-infra Terraform
  # expects (ami_owners_macos_arm64 = [<this-account-id>]).
  associate_public_ip_address = true
  source_ami                  = data.amazon-ami.macos_root_ami.id
  instance_type               = var.instance_type
  region                      = var.region
  ami_regions                 = var.ami_regions
  ssh_username                = "ec2-user"
  communicator                = "ssh"
  ssh_timeout                 = "1h"
  ebs_optimized               = true
  skip_create_ami             = var.skip_create_ami

  availability_zone = var.availability_zone

  # Force subnet selection into the default VPC's subnet for the host's AZ.
  # Without this Packer's auto-pick in the default VPC can land in a different
  # AZ than the dedicated host; without `default-for-az` it could land in a
  # custom VPC that lacks an internet gateway, breaking egress for brew/SSM/CW.
  subnet_filter {
    filters = {
      "availability-zone" : var.availability_zone
      "default-for-az" : "true"
    }
    most_free = true
    random    = false
  }

  tenancy = "host"
  placement {
    host_id = var.host_id
  }

  launch_block_device_mappings {
    delete_on_termination = true
    device_name           = "/dev/sda1"
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
  }

  # Required by org-level SCP: only IMDSv2 instances may be launched.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  run_tags = {
    Name      = "packer-${local.ami_name}"
    BuildTool = "packer"
    OS        = "macos"
    OSVersion = var.macos_version
    Arch      = "arm64"
  }

  tags = {
    Name      = local.ami_name
    BuildTool = "packer"
    OS        = "macos"
    OSVersion = var.macos_version
    Arch      = "arm64"
    SourceAMI = data.amazon-ami.macos_root_ami.id
  }

  # macOS AMIs take a long time to register.
  aws_polling {
    max_attempts = 600
  }
}

build {
  sources = ["source.amazon-ebs.macos_builder"]

  # Ensure brew is on PATH for non-interactive ssh sessions before Ansible runs.
  # The base AMI already ships Homebrew at /opt/homebrew (arm64) or /usr/local (x86_64).
  provisioner "shell" {
    inline = [
      "echo 'eval \"$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)\"' >> ~/.zprofile",
      "source ~/.zprofile || true",
      "brew --version",
    ]
  }

  provisioner "ansible" {
    playbook_file = "${path.root}/ansible/bake.yml"
    user          = "ec2-user"
    use_proxy     = false
    extra_arguments = [
      # Force legacy SCP protocol (-O); modern macOS scp defaults to SFTP which
      # the base AMI's SSH server sometimes refuses on the first connection.
      "--scp-extra-args=-O",
      # Retry the TCP connect to survive transient routing/firewall hiccups
      # immediately after Packer's own SSH session closes.
      "--ssh-extra-args=-o ConnectionAttempts=10 -o ConnectTimeout=30 -o ServerAliveInterval=30",
      "-e", "ansible_python_interpreter=/usr/bin/python3",
    ]
  }
}
