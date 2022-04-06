data "amazon-ami" "windows_root_ami" {
  filters = {
    name                = "Windows_Server-2019-English-Tesla-*"
    root-device-type    = "ebs"
    virtualization-type = "hvm"
  }
  most_recent = true
  owners      = ["amazon"]
  region      = "us-east-1"
}

locals {
  timestamp = regex_replace(timestamp(), "[- TZ:]", "")
}

source "amazon-ebs" "windows_ebs_builder" {
  ami_name                    = "Windows 2019 GHA CI - ${local.timestamp}"
  associate_public_ip_address = true
  communicator                = "winrm"
  instance_type               = "p3.2xlarge"
  launch_block_device_mappings {
    delete_on_termination = true
    device_name           = "/dev/sda1"
    volume_size           = 64
  }
  source_ami      = "${data.amazon-ami.windows_root_ami.id}"
  region          = "us-east-1"
  ami_regions     = ["us-east-1", "us-east-2"]
  user_data_file  = "user-data-scripts/bootstrap-winrm.ps1"
  winrm_insecure  = true
  winrm_use_ssl   = true
  winrm_username  = "Administrator"
  skip_create_ami = var.skip_create_ami
  aws_polling {
    # For some reason the AMIs take a really long time to be ready so just assume it'll take a while
    max_attempts = 600
  }
}

build {
  sources = ["source.amazon-ebs.windows_ebs_builder"]

  # Install sshd_config
  provisioner "file" {
    source      = "${path.root}/configs/sshd_config"
    destination = "C:\\ProgramData\\ssh\\sshd_config"
  }

  # Install ssh server
  provisioner "powershell" {
    elevated_user     = "SYSTEM"
    elevated_password = ""
    scripts = [
      "${path.root}/scripts/Installers/Install-SSH.ps1",
    ]
  }

  # Install the rest of the dependencies
  provisioner "powershell" {
    environment_vars = ["INSTALL_WINDOWS_SDK=0", "VS_VERSION=16.8.6"]
    execution_policy = "unrestricted"
    scripts = [
      "${path.root}/scripts/Helpers/Reset-UserData.ps1",
      "${path.root}/scripts/Installers/Install-Choco.ps1",
      "${path.root}/scripts/Installers/Install-Tools.ps1",
      "${path.root}/scripts/Installers/Install-VS.ps1",
    ]
  }

  # Install CUDA Toolkits
  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=10.2"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=11.1"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=11.3"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=11.5"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=11.6"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }
}
