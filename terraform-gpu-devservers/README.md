# GPU Developer Servers Infrastructure

Terraform configuration for PyTorch GPU development servers using AWS EKS with Kubernetes pod scheduling.

## Quick Start

### 1. Testing Setup (Current Default)

```bash
# Deploy with 4x T4 instances for testing (default configuration)
terraform init
terraform plan
terraform apply
```

### 2. Production Setup (Future)

```bash
# Deploy with H100 instances for production
terraform plan -var="instance_type=p5.48xlarge" -var="gpu_instance_count=5"
terraform apply -var="instance_type=p5.48xlarge" -var="gpu_instance_count=5"
```

## Current Configuration

**Testing Environment:**
- **Instance Type**: `g4dn.12xlarge` (4x T4 GPUs per instance)
- **Node Count**: 2 instances
- **Total GPUs**: 8x T4 GPUs available
- **Cost**: ~$7.82/hour total for cluster

**Production Plan:**
- **Instance Type**: `p5.48xlarge` (8x H100 GPUs per instance)
- **Node Count**: 5 instances  
- **Total GPUs**: 40x H100 GPUs available
- **Cost**: ~$490/hour total for cluster

## Configuration Options

### Customization Variables

```bash
# Override instance type
export TF_VAR_instance_type="g4dn.12xlarge"

# Override instance count
export TF_VAR_gpu_instance_count=2

# Override region
export TF_VAR_aws_region="us-east-2"
```

## Development - Connect to Kubernetes

To debug pods and services, configure kubectl to connect to your EKS cluster:

```bash
# Install kubectl (macOS)
brew install kubectl

# Configure kubectl for your EKS cluster
aws eks update-kubeconfig --region us-east-2 --name pytorch-gpu-dev-cluster

# Test connectivity
kubectl get nodes
kubectl get pods -n gpu-dev
kubectl get svc -n gpu-dev

# Debug a specific pod
kubectl logs <pod-name> -n gpu-dev
kubectl exec -it <pod-name> -n gpu-dev -- /bin/bash
```

## Architecture

The infrastructure includes:

- **EKS Cluster**: Kubernetes cluster for GPU pod scheduling
- **Node Groups**: GPU-enabled EC2 instances (g4dn.12xlarge)
- **Lambda Functions**: Process reservations and handle expiry
- **DynamoDB**: Store reservation and server state
- **SQS**: Queue system for async processing
- **NVIDIA Device Plugin**: Expose GPU resources to Kubernetes

## CLI Usage

Once deployed, use the CLI to make reservations:

```bash
# Configure your GitHub username for SSH access
gpu-dev config set github_user your-github-username

# Reserve GPUs
gpu-dev reserve --gpus 2 --hours 4

# List your reservations
gpu-dev list
```
