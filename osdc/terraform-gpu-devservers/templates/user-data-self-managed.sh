#!/bin/bash

# User data script for self-managed EKS GPU nodes (Ubuntu 22.04)
# Uses traditional /etc/eks/bootstrap.sh for cluster registration

set -o xtrace

# Disable IPv6 completely during boot to avoid metadata service issues
# This is the simplest and most reliable approach for p5.48xlarge instances

echo 'net.ipv6.conf.all.disable_ipv6 = 1' >> /etc/sysctl.conf
echo 'net.ipv6.conf.default.disable_ipv6 = 1' >> /etc/sysctl.conf
echo 'net.ipv6.conf.lo.disable_ipv6 = 1' >> /etc/sysctl.conf
sysctl -p

# Force cloud-init to use IPv4 only for metadata service
mkdir -p /etc/cloud/cloud.cfg.d
cat > /etc/cloud/cloud.cfg.d/99-disable-ipv6.cfg <<'EOF'
datasource:
  Ec2:
    metadata_urls: ['http://169.254.169.254']
    max_wait: 120
    timeout: 50
EOF

# Update system and install monitoring tools (Ubuntu uses apt)
apt-get update -y
apt-get install -y htop wget curl nvtop

# Join EKS cluster with GPU node labels
/etc/eks/bootstrap.sh ${cluster_name} \
    --apiserver-endpoint ${cluster_endpoint} \
    --b64-cluster-ca ${cluster_ca} \
    --container-runtime containerd \
    --kubelet-extra-args "--node-labels=GpuType=${gpu_type}"

# Configure EFA settings only for instances that actually have EFA hardware
if [[ -d /sys/class/infiniband/efa_0 || -e /dev/infiniband/uverbs0 ]]; then
    echo 'FI_PROVIDER=efa' >> /etc/environment
    echo 'NCCL_PROTO=simple' >> /etc/environment
    echo "EFA hardware detected - configured EFA environment variables"
else
    echo "No EFA hardware detected - skipping EFA configuration"
fi

# Network tuning using drop-in file (cleaner than modifying /etc/sysctl.conf)
cat >/etc/sysctl.d/99-gpu-net.conf <<'EOF'
net.core.rmem_default=262144000
net.core.rmem_max=262144000
net.core.wmem_default=262144000
net.core.wmem_max=262144000
EOF
sysctl --system

echo "Self-managed EKS node bootstrap completed successfully"