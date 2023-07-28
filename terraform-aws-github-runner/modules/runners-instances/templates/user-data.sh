#!/bin/bash -xe
set -x
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

${pre_install}

yum update -y

%{ if enable_cloudwatch_agent ~}
yum install amazon-cloudwatch-agent -y
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${ssm_key_cloudwatch_agent_config}
%{ endif ~}

# Install docker
amazon-linux-extras install docker
service docker start
usermod -a -G docker ec2-user

yum install -y curl jq git

USER_NAME=ec2-user
${install_config_runner}

echo Checking if nvidia install required ${nvidia_driver_install}
%{ if nvidia_driver_install ~}
set +e
os_id=$(awk -F= '/^ID/{print $2}' /etc/os-release)
if ! [[ "$os_id" =~ ^ubuntu.* ]]; then
    echo Installing Development Tools
    sudo yum groupinstall -y "Development Tools"
    sudo yum install -y "kernel-devel-uname-r == $(uname -r)"
    sudo modprobe backlight
fi
sudo curl -fsL -o /tmp/nvidia_driver "https://s3.amazonaws.com/ossci-linux/nvidia_driver/NVIDIA-Linux-x86_64-535.54.03.run"
sudo /bin/bash /tmp/nvidia_driver -s --no-drm
sudo rm -fv /tmp/nvidia_driver
set -e
%{ endif ~}

${post_install}

./svc.sh start
