data "amazon-ami" "windows_root_ami" {
  filters = {
    # Pin the last base AMI whose OpenSSH sshd service starts (used for the
    # 20260826001402 image); newer ones fail Install-SSH.ps1. Remove to unpin.
    image-id            = "ami-07fede2e6cf6d7f22"
    name                = "Windows_Server-2019-English-Full-Base-*"
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
  ami_groups                  = ["all"]
  snapshot_groups             = ["all"]
  associate_public_ip_address = true
  communicator                = "winrm"
  instance_type               = "g5.4xlarge"
  launch_block_device_mappings {
    delete_on_termination = true
    device_name           = "/dev/sda1"
    volume_size           = 128
  }
  source_ami      = "${data.amazon-ami.windows_root_ami.id}"
  region          = "us-east-1"
  ami_regions     = ["us-east-1"]
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

  # Install conda, it needs to be installed under SYSTEM to avoid this broken
  # installation https://github.com/ContinuumIO/anaconda-issues/issues/11799.
  provisioner "powershell" {
    elevated_user     = "SYSTEM"
    elevated_password = ""
    scripts = [
      "${path.root}/scripts/Installers/Install-Miniconda3.ps1",
      "${path.root}/scripts/Installers/Initialize-Python3.ps1",
      "${path.root}/scripts/Installers/Install-Conda-Dependencies.ps1",
      "${path.root}/scripts/Installers/Install-Pip-Dependencies.ps1",
    ]
  }

  # Stage sshd_config; Install-SSH.ps1 moves it into C:\ProgramData\ssh after
  # sshd has created that directory.
  provisioner "file" {
    source      = "${path.root}/configs/sshd_config"
    destination = "C:\\Windows\\Temp\\sshd_config"
  }

  # Install ssh server
  provisioner "powershell" {
    elevated_user     = "SYSTEM"
    elevated_password = ""
    scripts = [
      "${path.root}/scripts/Installers/Install-SSH.ps1",
    ]
  }

  # Install the Visual Studio 2022
  provisioner "powershell" {
    environment_vars = ["INSTALL_WINDOWS_SDK=1", "VS_YEAR=2022", "VS_VERSION=17.4.1", "VS_UNINSTALL_PREVIOUS=0"]
    execution_policy = "unrestricted"
    scripts = [
      "${path.root}/scripts/Installers/Install-VS.ps1",
    ]
  }

  # Install the rest of the dependencies
  # Please note: When modifying Microsoft.PowerShell_profile for a user
  # all modifications need to be done to Install-Choco-GenerateProfile script
  provisioner "powershell" {
    execution_policy = "unrestricted"
    scripts = [
      "${path.root}/scripts/Helpers/Reset-UserData.ps1",
      "${path.root}/scripts/Installers/Install-Choco-GenerateProfile.ps1",
      "${path.root}/scripts/Installers/Initialize-Python3.ps1",
      "${path.root}/scripts/Installers/Install-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=12.6"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=12.8"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=13.0"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=13.2"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=13.4"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  # Uninstall Windows Defender, it brings more trouble than it's worth. Do this
  # last as it screws up the installation of other services like sshd somehow
  provisioner "powershell" {
    elevated_user     = "SYSTEM"
    elevated_password = ""
    scripts = [
      "${path.root}/scripts/Helpers/Uninstall-WinDefend.ps1",
    ]
  }

  # Runners rely on sshd (SSH debugging, kill_active_ssh_sessions.ps1); don't
  # capture an image where a later step stopped it.
  provisioner "powershell" {
    inline = [
      "if ((Get-Service sshd).Status -ne 'Running') { throw 'sshd is not running at the end of provisioning' }",
    ]
  }
}
