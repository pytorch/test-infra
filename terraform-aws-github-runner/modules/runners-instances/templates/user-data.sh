#!/bin/bash

set -euxo pipefail

exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

OS_ID=$(. /etc/os-release;echo $ID$VERSION_ID)
if [[ "$OS_ID" =~ ^amzn2023* ]]; then
  PKG_MANAGER="dnf"
else
  PKG_MANAGER="yum"
fi

${pre_install}

if ! command -v curl 2>/dev/null; then
  echo "Installing curl"
  sudo $PKG_MANAGER install -y curl
fi

sudo sh -c "curl https://raw.githubusercontent.com/kadwanev/retry/master/retry -o /usr/local/bin/retry && chmod +x /usr/local/bin/retry"

sleep 3

sudo /usr/local/bin/retry "$PKG_MANAGER update -y"

if ! command -v jq 2>/dev/null; then
  echo "Installing jq"
  sudo /usr/local/bin/retry "$PKG_MANAGER install -y jq"
fi
if ! command -v git 2>/dev/null; then
  echo "Installing git"
  sudo /usr/local/bin/retry "$PKG_MANAGER install -y git"
fi
if ! command -v pip3 2>/dev/null; then
  echo "Installing git"
  sudo /usr/local/bin/retry "$PKG_MANAGER install -y pip"
fi

%{ if enable_cloudwatch_agent ~}
sudo /usr/local/bin/retry "$PKG_MANAGER install amazon-cloudwatch-agent -y"
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${ssm_key_cloudwatch_agent_config}
%{ endif ~}

# Install docker
if [ "$(uname -m)" == "aarch64" ]; then
  sudo /usr/local/bin/retry "$PKG_MANAGER install -y docker"
else
  if command -v amazon-linux-extras 2>/dev/null; then
    echo "Installing docker using amazon-linux-extras"
    sudo /usr/local/bin/retry "amazon-linux-extras install docker"
  else
    echo "Installing docker using dnf"
    sudo /usr/local/bin/retry "dnf install docker -y"
  fi
fi

service docker start
usermod -a -G docker ec2-user

USER_NAME=ec2-user
${install_config_runner}

sudo /usr/local/bin/retry "$PKG_MANAGER groupinstall -y 'Development Tools'"
sudo /usr/local/bin/retry "$PKG_MANAGER install -y 'kernel-devel-uname-r == $(uname -r)'"

echo Checking if nvidia install required ${nvidia_driver_install}
%{ if nvidia_driver_install ~}
echo "NVIDIA driver install required"
if [[ "$OS_ID" =~ ^amzn.* ]]; then
    if [[ "$OS_ID" =~ "amzn2023" ]] ; then
      echo "On Amazon Linux 2023, installing kernel-modules-extra"
      sudo /usr/local/bin/retry "dnf install kernel-modules-extra -y"
    fi
    echo Installing Development Tools
    sudo modprobe backlight
fi
sudo /usr/local/bin/retry "curl -fsL -o /tmp/nvidia_driver 'https://s3.amazonaws.com/ossci-linux/nvidia_driver/NVIDIA-Linux-x86_64-550.54.15.run'"
sudo /usr/local/bin/retry "/bin/bash /tmp/nvidia_driver -s --no-drm"
sudo rm -fv /tmp/nvidia_driver
if [[ "$OS_ID" =~ ^amzn.* ]]; then
    if [[ "$OS_ID" == ^amzn2023* ]]; then
      sudo /usr/local/bin/retry "dnf install -y dnf-plugins-core"
      sudo /usr/local/bin/retry "dnf config-manager --add-repo 'https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo'"
    else
      sudo /usr/local/bin/retry "yum install -y yum-utils"
      sudo /usr/local/bin/retry "yum-config-manager --add-repo 'https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo'"
    fi
    echo Installing nvidia-docker tools
    sudo /usr/local/bin/retry "$PKG_MANAGER install -y nvidia-docker2"
    sudo systemctl restart docker
fi
%{ endif ~}

${post_install}

./svc.sh start
