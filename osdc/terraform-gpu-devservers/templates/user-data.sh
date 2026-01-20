#!/bin/bash

# User data script for EKS GPU nodes
# Supports both testing (g4dn) and production (p5) instances

set -o xtrace

# Join the EKS cluster using the standard bootstrap script with GPU type label
/etc/eks/bootstrap.sh ${cluster_name} --kubelet-extra-args '--node-labels=GpuType=${gpu_type}'

# Install additional GPU monitoring tools
yum update -y
yum install -y htop

# Try to install nvtop (may not be available on all AMIs)
yum install -y nvtop || echo "nvtop not available"

# Configure EFA settings only for supported instances
# This will be harmless on instances that don't support EFA
echo 'FI_PROVIDER=efa' >> /etc/environment
echo 'NCCL_PROTO=simple' >> /etc/environment

# Basic network tuning (safe for all instances)
echo 'net.core.rmem_default = 262144000' >> /etc/sysctl.conf
echo 'net.core.rmem_max = 262144000' >> /etc/sysctl.conf
echo 'net.core.wmem_default = 262144000' >> /etc/sysctl.conf
echo 'net.core.wmem_max = 262144000' >> /etc/sysctl.conf
sysctl -p

echo "EKS node bootstrap completed successfully"