#!/bin/bash

# Simple Amazon Linux 2023 EKS node setup
# Remove any existing NVIDIA drivers and let GPU Operator manage them

set -o xtrace

# Disable the default nodeadm services that try to parse user-data as config
systemctl disable nodeadm-config.service || true
systemctl disable nodeadm-run.service || true
systemctl stop nodeadm-config.service || true
systemctl stop nodeadm-run.service || true

# Install NVIDIA driver 580.82.07 directly on host for CUDA 13 support
# GPU Operator will handle toolkit/device-plugin only

# Install NVIDIA driver
dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/amzn2023/x86_64/cuda-amzn2023.repo
dnf install -y nvidia-driver nvidia-driver-cuda

# Load NVIDIA modules
modprobe nvidia
modprobe nvidia_uvm

# Install basic monitoring tools
yum install -y htop wget

# Configure and run nodeadm for EKS cluster joining
# Get the base64 certificate data from AWS
CA_DATA=$(aws eks describe-cluster --region ${region} --name ${cluster_name} --query 'cluster.certificateAuthority.data' --output text)

cat > /tmp/nodeadm-config.yaml <<EOF
apiVersion: node.eks.aws/v1alpha1
kind: NodeConfig
spec:
  cluster:
    name: ${cluster_name}
    apiServerEndpoint: ${cluster_endpoint}
    certificateAuthority: $CA_DATA
    cidr: 172.20.0.0/16
  kubelet:
    config:
      clusterDNS:
        - 172.20.0.10
    flags:
      - --node-labels=NodeType=gpu,GpuType=${gpu_type},nvidia.com/gpu.deploy.driver=false
EOF

/usr/bin/nodeadm init --config-source file:///tmp/nodeadm-config.yaml

# Configure EFA if hardware present
if [[ -d /sys/class/infiniband/efa_0 || -e /dev/infiniband/uverbs0 ]]; then
    echo 'FI_PROVIDER=efa' >> /etc/environment
    echo 'NCCL_PROTO=simple' >> /etc/environment
fi

# Network tuning
cat >/etc/sysctl.d/99-gpu-net.conf <<'EOF'
net.core.rmem_default=262144000
net.core.rmem_max=262144000
net.core.wmem_default=262144000
net.core.wmem_max=262144000
EOF
sysctl --system

echo "Amazon Linux 2023 EKS GPU node setup completed"