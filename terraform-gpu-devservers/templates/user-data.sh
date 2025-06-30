#!/bin/bash

# User data script for EKS GPU nodes with EFA support

set -o xtrace

# Join the EKS cluster
/etc/eks/bootstrap.sh ${cluster_name} --container-runtime containerd --b64-cluster-ca $B64_CLUSTER_CA --apiserver-endpoint $API_SERVER_URL

# Enable EFA for NCCL
echo 'FI_PROVIDER=efa' >> /etc/environment
echo 'NCCL_PROTO=simple' >> /etc/environment

# Install additional GPU monitoring tools
yum update -y
yum install -y htop nvtop

# Configure EFA device
echo 'net.core.rmem_default = 262144000' >> /etc/sysctl.conf
echo 'net.core.rmem_max = 262144000' >> /etc/sysctl.conf
echo 'net.core.wmem_default = 262144000' >> /etc/sysctl.conf
echo 'net.core.wmem_max = 262144000' >> /etc/sysctl.conf
sysctl -p

# Signal completion
/opt/aws/bin/cfn-signal -e $? --stack ${cluster_name} --resource AutoScalingGroup --region ${region}