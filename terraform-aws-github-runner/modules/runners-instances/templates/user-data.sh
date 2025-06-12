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

${pre_install}

if ! command -v curl 2>/dev/null; then
  echo "Installing curl"
  sudo dnf install -y curl
fi

retry sudo dnf update -y

if ! command -v jq 2>/dev/null; then
  echo "Installing jq"
  retry sudo dnf install -y jq
fi
if ! command -v git 2>/dev/null; then
  echo "Installing git"
  retry sudo dnf install -y git
fi
if ! command -v pip3 2>/dev/null; then
  echo "Installing pip"
  retry sudo dnf install -y pip
fi

%{ if enable_cloudwatch_agent ~}
retry sudo dnf install amazon-cloudwatch-agent -y
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${ssm_key_cloudwatch_agent_config}
%{ endif ~}

# Install docker
if [ "$(uname -m)" == "aarch64" ]; then
  retry sudo dnf install -y docker
else
  if command -v amazon-linux-extras 2>/dev/null; then
    echo "Installing docker using amazon-linux-extras"
    retry sudo amazon-linux-extras install docker
  else
    echo "Installing docker using dnf"
    retry sudo dnf install docker -y
  fi
fi

USER_NAME=ec2-user

service docker start
usermod -a -G docker $USER_NAME

${install_config_runner}

retry sudo dnf groupinstall -y 'Development Tools'
retry sudo dnf install -y "kernel-devel-uname-r == $(uname -r)" || true

%{ if wiz_secrets_arn != null ~}
# Install Wiz Sensor - a runtime security agent
echo "Fetching Wiz secrets from AWS Secrets Manager"
WIZ_SECRET_RAW=$(retry aws secretsmanager get-secret-value --secret-id "${wiz_secrets_arn}" --region us-east-1 --query 'SecretString' --output text)
if [ $? -eq 0 ] && [ ! -z "$WIZ_SECRET_RAW" ]; then
  echo "Successfully retrieved Wiz secrets"
  echo "Extracting Wiz runtime sensor credentials"
  WIZ_SECRET_JSON=$(echo "$WIZ_SECRET_RAW" | tr -d '\n\r') # Remove newlines to fix malformed JSON (it's how it's stored in AWS Secrets Manager)
  WIZ_API_CLIENT_ID=$(echo "$WIZ_SECRET_JSON" | jq -r '.WIZ_RUNTIME_SENSOR_CLIENT_ID // empty')
  WIZ_API_CLIENT_SECRET=$(echo "$WIZ_SECRET_JSON" | jq -r '.WIZ_RUNTIME_SENSOR_CLIENT_SECRET // empty')
  if [ ! -z "$WIZ_API_CLIENT_ID" ] && [ ! -z "$WIZ_API_CLIENT_SECRET" ]; then
    echo "Installing Wiz runtime sensor"
    WIZ_API_CLIENT_ID="$WIZ_API_CLIENT_ID" WIZ_API_CLIENT_SECRET="$WIZ_API_CLIENT_SECRET" \
    sudo -E bash -c "$(curl -L https://downloads.wiz.io/sensor/sensor_install.sh)"
    echo "Wiz runtime sensor installation completed"
  else
    echo "Warning: WIZ_RUNTIME_SENSOR_CLIENT_ID or WIZ_RUNTIME_SENSOR_CLIENT_SECRET not found in secrets"
    metric_report "linux_userdata.wiz_credentials_missing" 1
  fi
else
  echo "Warning: Failed to retrieve Wiz secrets from ${wiz_secrets_arn}"
  metric_report "linux_userdata.wiz_secrets_error" 1
fi
  
# Clear all secrets from memory
unset WIZ_SECRET_RAW WIZ_SECRET_JSON WIZ_API_CLIENT_ID WIZ_API_CLIENT_SECRET
%{ endif ~}

echo Checking if nvidia install required ${nvidia_driver_install}
%{ if nvidia_driver_install ~}
echo "NVIDIA driver install required"

echo "Installing kernel-modules-extra"
retry sudo dnf install kernel-modules-extra -y
echo Installing Development Tools
sudo modprobe backlight

retry sudo curl -fsL -o /tmp/nvidia_driver 'https://s3.amazonaws.com/ossci-linux/nvidia_driver/NVIDIA-Linux-x86_64-570.133.07.run'
retry sudo /bin/bash /tmp/nvidia_driver -s --no-drm
sudo rm -fv /tmp/nvidia_driver

retry sudo dnf install -y dnf-plugins-core
retry sudo dnf config-manager --add-repo 'https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo'

echo Installing nvidia-docker tools
retry sudo dnf install -y nvidia-docker2
sudo systemctl restart docker

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
