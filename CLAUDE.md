# Agent notes

the first part of this doc is the devs description of the repo. Everything under the 'AGENT SECTION' is for you, the agent, to update state, tricky things, what we're working on and more.
This will help both you, the agent, but also other agents down the road that share the responsibility of this repo management to navigate the repo.

## Agent restrictions

- NEVER run `terraform apply` or any destructive terraform commands
- You can run read-only terraform commands like `terraform plan`, `terraform state show`, etc.
- You can run AWS CLI commands for read-only resource fetching and analysis
- User will handle all infrastructure deployments themselves
- Note: We use OpenTofu, so user runs `opentofu apply` or `tf apply` locally (tf is aliased to opentofu)
- we use k for kubectl and have kubens configured to namespace gpu-dev

## Development style

We like compact code, comments when needed, but only if they add value. For example, a variable called 'number_of_threads' does not need a comment that is contains number of threads.
We like tested code.

For frontend code we use yarn, yarn format, yarn tsc. yarn dev to run code, but leave it up to the dev to run that one.
For terraform, we use opentofu, don't ever run tf apply directly. You're free to run tf state/plan and other non-breaking commands though.

**Python Code Style:**

- Always put imports at the top of the file, never inside functions or methods
- Group imports in standard order: standard library, third-party, local imports
- Use absolute imports when possible

## Content

- torchci - a next.js app containing a PyTorch CI tracker
- aws - a bunch of lambdas & amis that are used in the tf module
- terraform-aws-github-runner - the definition of repos tofu modules. These modules are used in another repo to be deployed.
- cli-tools - the home of the gpu-dev cli tool that is used for creating/listing/cancelling reservations

## Current challenge and WIP

Currently we're working on a developer servers with GPUs in AWS. This means we'll need:

- a CLI tool for devs to reserve a server [DONE]
- a queue of open requests [DONE]
- a reservation for 2 EC2 H100 servers
- a way for devs to specify if they want 1/2/4/8 GPUs of a server [DONE]
- later, a way for devs to specify 2x8 GPUs, so they want a connected 2 server setup reserved for X hours
- we care about NIC connection - NVLINK or as fast as possible in one region / subregion.
- a lambda to process items from the queue if servers are available [DONE]
- a managed k8s to reserve, start a pod, interactive, and reserve that one for X hours for the dev (configurable) [DONE]
- auth can be through github public keys, all devs already have those exposed. This should be for devs with commit access to pytorch/pytorch only though. And part of metamates group in Github. [DONE]

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
- Within instance: GPUs use NVLINK folr direct communication
- Between instances: EFA provides fastest networking option
- Single AZ placement group recommended for best performance

**K8s Decision:** EKS with GPU-optimized EC2 node groups (Fargate has no GPU support)

## Implementation Status (Jan 11, 2025)

### ✅ Completed and Working

- **Infrastructure**: Dual-mode EKS with managed vs self-managed node groups for faster development
- **Networking**: Full DNS resolution and internet access for pods (CoreDNS + security groups fixed)
- **SSH Access**: Complete SSH server setup with proper package installation and daemon startup
- **Authentication**: GitHub public key fetching (ALL user keys, not just first one)
- **CLI Features**: Float hours support (e.g., --hours 0.25 for 15 minutes)
- **Reservation Display**: CLI list command shows formatted expiration times (YYYY-MM-DD HH:MM:SS)
- **Security Groups**: Full connectivity - kubelet (10250), control plane (443), DNS (53), NodePort (30000-32767)
- **Python CLI tool**: Commands: reserve, list, config with real-time polling
- **SQS + Lambda**: Async queue processing system with DynamoDB state tracking
- **Kubernetes**: Pod creation with GPU allocation, NodePort services, init containers
- **Expiry System**: Timestamp-based expiration tracking with historical records (TTL disabled)
- **DynamoDB**: Reservations kept as historical records, not auto-deleted
- **SSORole + instructions for that** - Implement SSO role authentication and provide setup instructions

### 📋 Remaining Tasks

- **Rename G6 to L4** - Update G6 references to L4 (similar to T4 GPU type naming)
- **Make gpu-type case agnostic** - Allow case-insensitive GPU type parameters (e.g., h100, H100, HuNdred should all work)
- **Error on non-existing GPU type** - Error out if people ask for a non-existing GPU type
- **Error on too many GPUs** - Error out if people ask for more GPUs than available in node (8 for H100/B200, 4 for T4, etc.)
- **Increase /dev/shm for NCCL** - Bump /dev/shm space from 64MB for NCCL requirements (https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting.html#docker)
- **Fix GPU SKU validation** - Add proper error handling for non-existing/unavailable GPU types (e.g., user requesting A100 when only T4 available should get immediate error, not pending pod that will never schedule)
- **Set HuggingFace cache location** - Set HF_HOME or XDG_CACHE_HOME to /tmp or /workspace so HuggingFace doesn't fill up user home directories with model downloads
- **Add network drive (EFS)** - Implement 20TB EFS shared storage mounted at /shared with user folders
- **Add verbose CLI output** - More detailed status and progress information for debugging
- **Interactive CLI for cancel/edit** - Make `gpu-dev cancel` and `gpu-dev edit` interactive when no reservation ID specified - show list with up/down arrow selection
- **Default reservation edit/cancel** - Auto-select reservation if user only has one active
- **Custom Docker image scaffold** - Create Dockerfile with pre-installed packages (Jupyter, etc.)
- **Add a command gpu-dev availability** that shows how many gpus of each type are available to reserve at the moment, and if 0, what the estimated queue time is
- **Production deployment** - Switch to p5.48xlarge instances when ready
- **Investigate NFS** - Research NFS integration for shared storage across pods
- **Persistent disk** - Implement persistent disk storage for user data across sessions
- **Validate CUDA version** - Add CUDA version validation and display in container startup
- **Validate NVIDIA driver version** - Display and validate NVIDIA driver version
- **Test wall messages** - Verify that wall message functionality works correctly
- **Validate if expiration works as expected** - Test and verify pod cleanup and reservation expiry process
- **Simplify code + clean up** - Refactor and clean up codebase for maintainability
- **Add Docker** - Install and configure Docker in development containers - maybe --docker at reserve, which will use dind if possible to the container (to investigate how feasible)
- **Add Docker CI image run** - allow user to specify gpu-dev ci-debug <testurl> that downloads that docker-image and goes for it
- **Add ghstack** - Install ghstack tool for GitHub stack management
- **Improve debugging and observability** - Add better CLI feedback for pod status, container logs, and error details. Current debugging experience is poor - users need kubectl/aws cli knowledge to debug issues. CLI should show:
  - Real-time pod startup logs during `gpu-dev reserve` 
  - Container error messages when pods fail
  - Image pull status and errors
  - Resource allocation details
  - More detailed error messages with troubleshooting hints
- **Add CloudWatch logs for pods** - Store pod logs in CloudWatch for better debugging and monitoring
- **Add tests for everything** - Implement comprehensive test suite for all components
- **Investigate multi node communication** - Research inter-node networking for multi-GPU setups
- **FQDN for devservers** - Set up proper domain names for development server access
- **Switch between H100/B200 GPU types** - Add `--gpu-type=b200` CLI option with separate queues per GPU type
- **GPU queue status command** - Add status command to show queue length per GPU type (eg, `gpu-dev queue-status`)
- **Jupyter notebook integration** - Add `--jupyter` flag to enable Jupyter notebook and TensorBoard access
- **Add user collaboration feature** - Add `--add-user <github_name>` flag to allow users to add someone to the server
- **Display Bug:** - CLI shows "G6" instead of "L4" in availability table - likely resolves on prod release when Lambda functions are updated with new GPU type mappings
- **Fix extend command warning cleanup** - When using `--extend`, the system doesn't remove the WARN_EXPIRES_IN_5MIN.txt file and doesn't reset the expiry warning tracking in the database. Need to either clear the warning state from the table or keep warning history elsewhere for auditing purposes
- **Future features**:
  - Multi-server (16 GPU) reservations
  - GitHub organization/team verification
  - Reservation extensions
  - Usage monitoring and quotas

## Current Working Architecture

**Infrastructure (us-east-2):**

- **Current**: 2x p4d.24xlarge instances (8 A100 GPUs each = 16 total GPUs)
- **Previous testing**: 2x g4dn.12xlarge instances (4 T4 GPUs each = 8 total GPUs)
- **Future**: 2x p5.48xlarge instances (8 H100 GPUs each = 16 total GPUs) when capacity available
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
