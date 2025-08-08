# Agent notes

the first part of this doc is the devs description of the repo. Everything under the 'AGENT SECTION' is for you, the agent, to update state, tricky things, what we're working on and more.
This will help both you, the agent, but also other agents down the road that share the responsibility of this repo management to navigate the repo.

## Agent restrictions

- NEVER run `terraform apply` or any destructive terraform commands
- You can run read-only terraform commands like `terraform plan`, `terraform state show`, etc.  
- You can run AWS CLI commands for read-only resource fetching and analysis
- User will handle all infrastructure deployments themselves
- Note: We use OpenTofu, so user runs `opentofu apply` or `tf apply` locally (tf is aliased to opentofu)

## Development style

We like compact code, comments when needed, but only if they add value. For example, a variable called 'number_of_threads' does not need a comment that is contains number of threads.
We like tested code.

For frontend code we use yarn, yarn format, yarn tsc. yarn dev to run code, but leave it up to the dev to run that one.
For terraform, we use opentofu, don't ever run tf apply directly. You're free to run tf state/plan and other non-breaking commands though.

We talk like a pirate, like to add puns to our internal chat, but keep our code free of such chenanagins. When talking to the user however, make sure to throw the occasional pun in the chat.

## Content

- torchci - a next.js app containing a PyTorch CI tracker
- aws - a bunch of lambdas & amis that are used in the tf module
- terraform-aws-github-runner - the definition of repos tofu modules. These modules are used in another repo to be deployed.

## Current challenge and WIP

Currently we're working on a developer servers with GPUs in AWS. This means we'll need:

- a CLI tool for devs to reserve a server
- a queue of open requests
- a reservation for 2 EC2 H100 servers
- a way for devs to specify if they want 1/2/4/8 GPUs of a server
- later, a way for devs to specify 2x8 GPUs, so they want a connected 2 server setup reserved for X hours
- we care about NIC connection - NVLINK or as fast as possible in one region / subregion.
- a lambda to process items from the queue if servers are available
- a state of # EC2 servers that are avaialble
- a managed k8s to reserve, start a pod, interactive, and reserve that one for X hours for the dev (configurable)
- a management bastion for us to connect to
- auth can be through github public keys, all devs already have those exposed. This should be for devs with commit access to pytorch/pytorch only though. And part of metamates group in Github.

# AGENT SECTION

## Issues I found with the description above

- I am not sure terraform-aws-github-runner is correctly described. Next time I go over this code for maintenance or adding something, I'll inform the user of what I think should change. This is not an active goal though, just a sidequest.
- The user asked for NIC connections. I still need to figure out how fast and what's avaiable @ AWS, When I do that, I'll update this section below:

## NIC explanation in AWS

**EFA (Elastic Fabric Adapter):**

- Low-latency, high-throughput networking for HPC/AI workloads
- 3200 Gbps bandwidth on p5.48xlarge instances
- RDMA support, bypasses kernel for direct hardware access
- Integrates with NVIDIA NCCL for multi-GPU communication
- **Critical limitation**: Cannot cross Availability Zones - all instances must be in same AZ

**H100 Instance Performance (p5.48xlarge):**

- 8x NVIDIA H100 GPUs (80GB each = 640GB total GPU memory)
- Within instance: GPUs use NVLINK for direct communication
- Between instances: EFA provides fastest networking option
- Single AZ placement group recommended for best performance

**K8s Decision:** EKS with GPU-optimized EC2 node groups (Fargate has no GPU support)

## Implementation Status (Jan 8, 2025)

### ✅ Completed and Working
- EKS cluster with GPU node groups (g4dn.12xlarge, 4 GPUs each)
- Python CLI tool for reservations with GitHub username config
- SQS + Lambda queue processing system
- DynamoDB state tracking for reservations and servers
- Kubernetes pod creation with GPU resource allocation
- NVIDIA device plugin for GPU exposure
- NodePort services for SSH access to pods
- GitHub public key injection for SSH authentication
- Real SSH commands with copy-pasteable format
- Lambda EKS authentication via AWS STS signing
- aws-auth ConfigMap with proper Lambda role permissions
- Reservation expiry logic with pod cleanup

### 🐛 Current Issue (Jan 8, 2025)

**SSH Connection Refused:**
- Pods are successfully created and scheduled
- NodePort services are created with correct port mappings
- Security groups allow NodePort traffic (30000-32767)
- SSH connection gets "Connection refused" instead of hanging
- Likely issue: SSH server not starting properly in PyTorch container

**Debugging Steps:**
- Security group updated to allow NodePort range ✅
- Need to check pod logs to verify SSH daemon startup
- May need to adjust container SSH installation/startup process

### 📋 Next Steps

1. **Debug SSH connectivity** - Check pod logs for SSH daemon startup issues
2. **Test complete workflow** - Verify end-to-end reservation → SSH → cleanup flow  
3. **Production deployment** - Switch to p5.48xlarge instances for production
4. **Add features**:
   - Multi-server (16 GPU) reservations
   - GitHub organization/team verification
   - Reservation extensions
   - Usage monitoring and quotas

### 🔧 Known Issues to Address

**GPU Allocation State:**
- Initialize Lambda resets available_gpus without checking active reservations
- Could cause inconsistent state during infrastructure updates
- Need reconciliation logic to preserve active reservations

## Current Working Architecture

**Infrastructure (us-east-2):**
- **Testing**: 2x g4dn.12xlarge instances (4 GPUs each = 8 total GPUs)
- **Production plan**: 5x p5.48xlarge instances (8 H100 GPUs each = 40 total GPUs)
- EKS cluster with GPU-optimized node groups
- NVIDIA device plugin for GPU resource exposure
- Single AZ deployment with cluster placement groups

**Reservation System:**
- SQS queue for async reservation requests
- Lambda functions for pod creation and expiry management
- DynamoDB for reservation and server state tracking
- Kubernetes pods with GPU resource allocation (1/2/4 GPUs)
- NodePort services for SSH access to pods

**Authentication & Access:**
- GitHub username configuration for SSH key fetching
- Public key injection into pods via init containers
- Copy-pasteable SSH commands with NodePort access

**CLI Tool:**
- Python CLI with config at `~/.gpu-dev-config`
- Commands: `reserve`, `list`, `config`
- Real-time polling until reservation is ready
