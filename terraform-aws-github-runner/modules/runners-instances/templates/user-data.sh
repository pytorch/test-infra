#!/bin/bash -xe

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

%{ if nvidia_driver_install ~}
sudo curl -fsL -o /tmp/nvidia_driver "https://s3.amazonaws.com/ossci-linux/nvidia_driver/NVIDIA-Linux-x86_64-535.54.03.run"
sudo /bin/bash /tmp/nvidia_driver -s --no-drm
sudo rm -fv /tmp/nvidia_driver
%{ endif ~}

${post_install}

./svc.sh start
