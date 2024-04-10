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

  # Install the Visual Studio 2019
  provisioner "powershell" {
    environment_vars = ["INSTALL_WINDOWS_SDK=1", "VS_YEAR=2019", "VS_VERSION=16.11.21", "VS_UNINSTALL_PREVIOUS=1"]
    execution_policy = "unrestricted"
    scripts = [
      "${path.root}/scripts/Installers/Install-VS.ps1",
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
  provisioner "powershell" {
    execution_policy = "unrestricted"
    scripts = [
      "${path.root}/scripts/Helpers/Reset-UserData.ps1",
      "${path.root}/scripts/Installers/Install-Choco.ps1",
      "${path.root}/scripts/Installers/Install-Tools.ps1",
    ]
  }

  # Install conda, it needs to be installed under SYSTEM to avoid this broken
  # installation https://github.com/ContinuumIO/anaconda-issues/issues/11799.
  # Also this needs to come after all the tools are installed to avoid error
  # CondaHTTPError: HTTP 000 CONNECTION FAILED when connecting to conda (?)
  provisioner "powershell" {
    elevated_user     = "SYSTEM"
    elevated_password = ""
    scripts = [
      "${path.root}/scripts/Installers/Install-Miniconda3.ps1",
      "${path.root}/scripts/Installers/Install-Conda-Dependencies.ps1",
      "${path.root}/scripts/Installers/Install-Pip-Dependencies.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=11.8"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=12.1"]
    scripts = [
      "${path.root}/scripts/Installers/Install-CUDA-Tools.ps1",
    ]
  }

  provisioner "powershell" {
    environment_vars = ["CUDA_VERSION=12.4"]
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
}
