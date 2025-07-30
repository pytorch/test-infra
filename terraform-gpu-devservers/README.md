# GPU Developer Servers Infrastructure

Terraform configuration for PyTorch GPU development servers with cost-flexible instance types.

## Quick Start

### 1. Testing Setup (Cheap)
```bash
# Deploy with cheap T4 instances for testing
terraform init
terraform plan -var="instance_type=g4dn.2xlarge" -var="gpu_instance_count=2"
terraform apply -var="instance_type=g4dn.2xlarge" -var="gpu_instance_count=2"
```

### 2. Mid-Range Setup  
```bash
# Deploy with A10G instances for development
terraform plan -var="instance_type=g5.2xlarge" -var="gpu_instance_count=3"
terraform apply -var="instance_type=g5.2xlarge" -var="gpu_instance_count=3"
```

### 3. Production Setup
```bash
# Deploy with H100 instances for production
terraform plan -var="instance_type=p5.48xlarge" -var="gpu_instance_count=5"
terraform apply -var="instance_type=p5.48xlarge" -var="gpu_instance_count=5"
```

## Instance Types & Costs

| Instance Type | GPUs | GPU Type | Cost/Hour | Use Case |
|---------------|------|----------|-----------|----------|
| `g4dn.xlarge` | 1x | T4 | ~$0.53 | Basic testing |
| `g4dn.2xlarge` | 1x | T4 | ~$0.75 | **Testing (default)** |
| `g5.2xlarge` | 1x | A10G | ~$1.21 | Development |
| `g5.4xlarge` | 1x | A10G | ~$1.64 | Mid-range |
| `p3.2xlarge` | 1x | V100 | ~$3.06 | Training |
| `p5.48xlarge` | 8x | H100 | ~$98.00 | **Production** |

## Configuration Options

### Environment Variables
```bash
export TF_VAR_instance_type="g4dn.2xlarge"
export TF_VAR_gpu_instance_count=2
export TF_VAR_key_pair_name="your-key-pair"
```

### Terraform Variables File
Create `terraform.tfvars`:
```hcl
# Testing configuration
instance_type = "g4dn.2xlarge"
gpu_instance_count = 2
key_pair_name = "your-key-pair"

# Production configuration (commented out)
# instance_type = "p5.48xlarge" 
# gpu_instance_count = 5
```

## Features by Instance Type

### Testing Instances (g4dn, g5)
- Basic GPU compute
- Standard networking
- Cost-effective for development
- Single GPU per instance

### Production Instances (p5.48xlarge)
- 8x H100 GPUs per instance
- EFA networking for multi-node
- Cluster placement groups
- Optimized for AI/ML workloads

## Deployment Commands

```bash
# Initialize
terraform init

# Plan with specific instance type
terraform plan -var="instance_type=g4dn.2xlarge"

# Apply
terraform apply -var="instance_type=g4dn.2xlarge"

# Destroy when done
terraform destroy
```

## CLI Testing

Both Python and Rust CLIs support test mode:

```bash
# Python CLI test mode
gpu-dev --test reserve --gpus 2 --hours 4
gpu-dev --test list
gpu-dev --test status

# Rust CLI test mode  
gpu-dev --test reserve --gpus 2 --hours 4
gpu-dev --test list
gpu-dev --test status
```

## Cost Management

- Start with `g4dn.2xlarge` for testing (~$1.50/hour for 2 instances)
- Scale to `g5.2xlarge` for development (~$3.63/hour for 3 instances)
- Use `p5.48xlarge` only for production (~$490/hour for 5 instances)

## Outputs

After deployment, you'll get:
- EKS cluster name
- SQS queue URL
- DynamoDB table names
- CLI configuration values

Use these outputs to configure your CLI tools.