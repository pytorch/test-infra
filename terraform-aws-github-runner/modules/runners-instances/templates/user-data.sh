#!/bin/bash

set -exo pipefail

function metric_report () {
    local metric_name=$1
    local value=$2

    aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "GHARunners/all/infra" --value $value --region us-east-1 || true

    local namespace="GHARunners/all/infra"
    if [ ! -z "${environment}" ]; then
        namespace="GHARunners/${environment}/infra"
        aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "$namespace" --value $value --region us-east-1 || true
    fi

    if [ ! -z "$REGION" ]; then
        aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "$namespace" --value $value --region us-east-1 --dimensions "Region=$REGION" || true
    fi
    if [ ! -z "$OS_ID" ]; then
        aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "$namespace" --value $value --region us-east-1 --dimensions "os=$OS_ID" || true
    fi
}

function err_report () {
    echo "Error on line $1"
    metric_report "linux_userdata.error" 1
    exit 1
}

trap 'err_report $LINENO' ERR

function retry {
  local retries=7
  local count=0
  until "$@"; do
    exit=$?
    wait=$((2 ** $count))
    count=$(($count + 1))
    if [ $count -lt $retries ]; then
      echo "Retry $count/$retries exited $exit, retrying in $wait seconds..."
      sleep $wait
    else
      echo "Retry $count/$retries exited $exit, no more retries left."
      return $exit
    fi
  done
  return 0
}

exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

metric_report "linux_userdata.execution" 1

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

retry sudo $PKG_MANAGER update -y

if ! command -v jq 2>/dev/null; then
  echo "Installing jq"
  retry sudo $PKG_MANAGER install -y jq
fi
if ! command -v git 2>/dev/null; then
  echo "Installing git"
  retry sudo $PKG_MANAGER install -y git
fi
if ! command -v pip3 2>/dev/null; then
  echo "Installing git"
  retry sudo $PKG_MANAGER install -y pip
fi

%{ if enable_cloudwatch_agent ~}
retry sudo $PKG_MANAGER install amazon-cloudwatch-agent -y
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${ssm_key_cloudwatch_agent_config}
%{ endif ~}

# Install docker
if [ "$(uname -m)" == "aarch64" ]; then
  retry sudo $PKG_MANAGER install -y docker
else
  if command -v amazon-linux-extras 2>/dev/null; then
    echo "Installing docker using amazon-linux-extras"
    retry sudo amazon-linux-extras install docker
  else
    echo "Installing docker using dnf"
    retry sudo dnf install docker -y
  fi
fi

service docker start
usermod -a -G docker ec2-user

USER_NAME=ec2-user
${install_config_runner}

retry sudo $PKG_MANAGER groupinstall -y 'Development Tools'
retry sudo $PKG_MANAGER install -y "kernel-devel-uname-r == $(uname -r)" || true

echo Checking if nvidia install required ${nvidia_driver_install}
%{ if nvidia_driver_install ~}
echo "NVIDIA driver install required"
if [[ "$OS_ID" =~ ^amzn.* ]]; then
    if [[ "$OS_ID" =~ "amzn2023" ]] ; then
      echo "On Amazon Linux 2023, installing kernel-modules-extra"
      retry sudo dnf install kernel-modules-extra -y
    fi
    echo Installing Development Tools
    sudo modprobe backlight
fi
retry sudo curl -fsL -o /tmp/nvidia_driver 'https://s3.amazonaws.com/ossci-linux/nvidia_driver/NVIDIA-Linux-x86_64-570.133.07.run'
retry sudo /bin/bash /tmp/nvidia_driver -s --no-drm
sudo rm -fv /tmp/nvidia_driver
if [[ "$OS_ID" =~ ^amzn.* ]]; then
    if [[ "$OS_ID" == ^amzn2023* ]]; then
      retry sudo dnf install -y dnf-plugins-core
      retry sudo dnf config-manager --add-repo 'https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo'
    else
      retry sudo yum install -y yum-utils
      retry sudo yum-config-manager --add-repo 'https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo'
    fi
    echo Installing nvidia-docker tools
    retry sudo $PKG_MANAGER install -y nvidia-docker2
    sudo systemctl restart docker
fi
%{ endif ~}

${post_install}

if [[ -f /swapfile ]]; then
  # Cleanup any existing swapfile just to be sure
  sudo swapoff /swapfile
  sudo rm /swapfile
fi
# before allocating a new one
sudo fallocate -l 3G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

./svc.sh start

metric_report "linux_userdata.success" 1
