#!/bin/bash

# User data script for self-managed EKS GPU nodes (AL2023)
# Uses nodeadm for cluster registration instead of bootstrap.sh

set -o xtrace

# Create nodeadm configuration for AL2023
cat <<EOF > /tmp/nodeadm-config.yaml
apiVersion: node.eks.aws/v1alpha1
kind: NodeConfig
spec:
  cluster:
    name: ${cluster_name}
    apiServerEndpoint: ${cluster_endpoint}
    certificateAuthority: ${cluster_ca}
    cidr: ${cluster_cidr}
  kubelet:
    config:
      clusterDNS:
        - 172.20.0.10
    flags:
      - --node-labels=GpuType=${gpu_type}
EOF

# Initialize node with nodeadm
nodeadm init --config-source file:///tmp/nodeadm-config.yaml

# Install additional GPU monitoring tools (AL2023 uses dnf)
dnf update -y
dnf install -y htop

# Try to install nvtop (may not be available on all AMIs)
dnf install -y nvtop || echo "nvtop not available"

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

echo "Self-managed EKS node bootstrap completed successfully"