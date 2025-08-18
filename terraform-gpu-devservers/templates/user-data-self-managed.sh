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
    apiServerEndpoint: https://F2607FF61905D0D2D265A7125F34C8CD.gr7.us-east-2.eks.amazonaws.com
    certificateAuthority: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURCVENDQWUyZ0F3SUJBZ0lJQTlJQTVVWDJybk13RFFZSktvWklodmNOQVFFTEJRQXdGVEVUTUJFR0ExVUUKQXhNS2EzVmlaWEp1WlhSbGN6QWVGdzB5TlRBNE1UTXlNakl3TVROYUZ3MHpOVEE0TVRFeU1qSTFNVE5hTUJVeApFekFSQmdOVkJBTVRDbXQxWW1WeWJtVjBaWE13Z2dFaU1BMEdDU3FHU0liM0RRRUJBUVVBQTRJQkR3QXdnZ0VLCkFvSUJBUUMxQVNDU0hBWkk5SnFaOHJlUU1LWjNPbXBYc0lXOTlCUUQ3Tmpqb3FlTWtKdFBYMEtRdmtjSFFEbXgKdC9QZlZSTDhBZGEydGxFKzZxVmFqQmE4ODhlelBwc1p6V2NNeDgrcUFxQ29qRWZ5K0EvTXhqYjRxK0RwMTNZYgp3bnp3MGFpbDF5cXBsdTBHSkQ4N2d5WjI0bjZQd1IxVENZTHVRTVl4dTdwTENJbE04dkRweHhlQ0xJVUVjSEh5CjFXWHdDblE0b0dEbXN4RmxjVE01MW1DWVRncGtnM0h2ZWd0ZDN4N3ZsOE40anV1VUNFY0ZBd1AwMFdKV2MxTlIKT2dZd0xEemxDeXo4aFBDUlFsbXMyVjVSQll6RHNvbldCU3NqWFdXZWUxZnIwR3p3bEhLclpmc0V1ZFNINm9UMgpmNStBbUVYWVpaTmlIa3RQcElVOEw3ZmtOYnE5QWdNQkFBR2pXVEJYTUE0R0ExVWREd0VCL3dRRUF3SUNwREFQCkJnTlZIUk1CQWY4RUJUQURBUUgvTUIwR0ExVWREZ1FXQkJTQ1JsQ3pXVlJSTHFZcFRnQWlLY3NkMHJFSStEQVYKQmdOVkhSRUVEakFNZ2dwcmRXSmxjbTVsZEdWek1BMEdDU3FHU0liM0RRRUJDd1VBQTRJQkFRQk1qNDBDMUk2ZgpZNUdpTVpySGZVOU1TOUpuRnlCZit6M3dqeDBSUTFReEhaUjJqNHpSSytzKzVSWnNlQUNuZlVVRHp4dTBQRlJSCkdmUEg5b3ZlS24wSTNLa3pYbHJEZHI1d1RtQkF0bE1CRXJtU3pncEJySGV5WU41SmVuWW9IRFk2dnM1RFAvcGoKWXdDbG03TEdnSHNkdzdLVFMrVGxIbzlRWVdmQmxTN09GUnpQdGkxWWNsdnE3NkgwenZJbkhGSHJla2RmKzg1NQpvWkhRUkVPbUs5Y25Lem5COTJqMFcwRUh6d0UzbE1MdllZR0ZTTVZvUHhWeEE0NXg1WTFDcE9Bdks0c2ZLTkN3CmhGMkNLSzVpMkI1ODZhNUhkeENjWkFVd0R0VkJiZDlyRXB6czNiK3RyaXIzb291NytoKzBvNWFvOGxSK0NjSXUKazJXSkFHaEJ6OWxsCi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K
    cidr: 10.0.0.0/16
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