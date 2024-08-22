#!/bin/bash -xe
set -x
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

${pre_install}

sudo yum update -y

%{ if enable_cloudwatch_agent ~}
sudo yum install amazon-cloudwatch-agent -y
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${ssm_key_cloudwatch_agent_config}
%{ endif ~}

# Install docker
if [ "$(uname -m)" == "aarch64" ]; then
  sudo yum install -y docker
else
  if command -v amazon-linux-extras 2>/dev/null; then
    echo "Installing docker using amazon-linux-extras"
    sudo amazon-linux-extras install docker
  else
    echo "Installing docker using dnf"
    sudo dnf install docker -y
  fi
fi

service docker start
usermod -a -G docker ec2-user

if ! command -v curl 2>/dev/null; then
  echo "Installing curl"
  sudo yum install -y curl
fi
if ! command -v jq 2>/dev/null; then
  echo "Installing jq"
  sudo yum install -y jq
fi
if ! command -v git 2>/dev/null; then
  echo "Installing git"
  sudo yum install -y git
fi

USER_NAME=ec2-user
${install_config_runner}

echo Checking if nvidia install required ${nvidia_driver_install}
%{ if nvidia_driver_install ~}
set +e

os_id=$(. /etc/os-release;echo $ID$VERSION_ID)
if [[ "$os_id" =~ ^amzn.* ]]; then
    if [[ "$os_id" =~ "amzn2023" ]] ; then
      echo "On Amazon Linux 2023, installing kernel-modules-extra"
      sudo dnf install kernel-modules-extra -y
    fi
    echo Installing Development Tools
    sudo yum groupinstall -y "Development Tools"
    sudo yum install -y "kernel-devel-uname-r == $(uname -r)"
    sudo modprobe backlight
fi
sudo curl -fsL -o /tmp/nvidia_driver "https://s3.amazonaws.com/ossci-linux/nvidia_driver/NVIDIA-Linux-x86_64-550.54.15.run"
sudo /bin/bash /tmp/nvidia_driver -s --no-drm
sudo rm -fv /tmp/nvidia_driver
if [[ "$os_id" =~ ^amzn.* ]]; then
    echo Installing nvidia-docker tools
    sudo yum install -y yum-utils
    sudo yum-config-manager --add-repo https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo
    sudo yum install -y nvidia-docker2
    sudo systemctl restart docker
fi
set -e
%{ endif ~}

${post_install}

./svc.sh start
