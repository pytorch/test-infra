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
- **Rename G6 to L4** - Update G6 references to L4 (similar to T4 GPU type naming)
- **Add network drive (EFS)** - Implement 20TB EFS shared storage mounted at /shared with user folders
- **GPU Profiling Support** - Added NVIDIA profiling capabilities for all pods:
  - Node-level: Added `options nvidia NVreg_RestrictProfilingToAdminUsers=0` to `/etc/modprobe.d/nvprof.conf` in node bootstrap script - automatically configured on ALL new GPU nodes
  - Bootstrap: Configuration added at `terraform-gpu-devservers/templates/al2023-user-data.sh:17-19` (applied BEFORE NVIDIA driver installation to avoid auto-load issue)
  - Pod-level: Added Linux capability `SYS_ADMIN` to all GPU pods (required for NVIDIA profiling tools like ncu/nsys)
  - Environment: Set `NVIDIA_DRIVER_CAPABILITIES=compute,utility` (note: `profile` is NOT supported by NVIDIA device plugin)
  - Location: `terraform-gpu-devservers/lambda/reservation_processor/index.py:4000` and `:3984`
- **GPU Monitoring with Grafana** - Added full GPU monitoring stack:
  - DCGM Exporter enabled in GPU Operator with anti-affinity for profiling nodes
  - kube-prometheus-stack deployed with 50GB persistent storage (15-day retention)
  - Grafana accessible via NodePort 30080 on any node IP
  - Pre-loaded NVIDIA DCGM dashboard (Grafana ID 12239) + custom GPU Overview dashboard
  - Configuration: `terraform-gpu-devservers/monitoring.tf`

## GPU Monitoring & Profiling Node Setup (Dec 2025)

**Architecture:**
- DCGM Exporter runs on ALL GPU nodes EXCEPT profiling-dedicated nodes
- Profiling-dedicated nodes: ONE H100 and ONE B200 node reserved for Nsight profiling
- DCGM and Nsight conflict because both need exclusive GPU access

**Profiling Node Labeling (manual, one-time setup after `tf apply`):**
```bash
# List H100 nodes and pick ONE for profiling
kubectl get nodes -l gpu-type=h100

# Label one H100 node as profiling-dedicated (DCGM will NOT run on this node)
kubectl label node <h100-node-name> gpu.monitoring/profiling-dedicated=true

# List B200 nodes and pick ONE for profiling
kubectl get nodes -l gpu-type=b200

# Label one B200 node as profiling-dedicated
kubectl label node <b200-node-name> gpu.monitoring/profiling-dedicated=true

# Verify labels
kubectl get nodes -l gpu.monitoring/profiling-dedicated=true
```

**Grafana Access:**
```bash
# Get any node IP
kubectl get nodes -o wide

# Access Grafana at: http://<node-ip>:30080
# Default credentials: admin / (value of grafana_admin_password variable)
```

**Available Dashboards:**
- NVIDIA DCGM Exporter Dashboard (pre-configured from Grafana community)
- GPU Overview (custom dashboard with utilization, memory, temp, power)

**Troubleshooting:**
```bash
# Check DCGM pods are running (should NOT be on profiling nodes)
kubectl get pods -n gpu-operator -l app=nvidia-dcgm-exporter -o wide

# Verify Prometheus is scraping DCGM
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
# Then open http://localhost:9090 and query: DCGM_FI_DEV_GPU_UTIL

# Check Grafana pods
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
```

## Recent Fixes (Oct 27, 2025)

**NVIDIA Profiling Bootstrap Configuration (Oct 27, 2025):**
- **Bug Found**: NVIDIA driver installation (`dnf install nvidia-driver`) automatically loads kernel modules during install, so config must be created BEFORE driver installation, not just before explicit modprobe
- **Fix**: Moved `echo "options nvidia NVreg_RestrictProfilingToAdminUsers=0" > /etc/modprobe.d/nvprof.conf` to line 19 (before driver install at line 23)
- **Previous Location**: Line 59-60 (after driver install) - TOO LATE, modules already loaded during dnf install
- **New Location**: `terraform-gpu-devservers/templates/al2023-user-data.sh:17-19` (before driver installation)
- **Benefit**: All new GPU nodes will have profiling enabled automatically without requiring manual configuration or reboots
- **Rollout**: Run `tf apply` to update launch template, then terminate existing nodes so ASG recreates them with new bootstrap script

## Recent Fixes (Oct 8, 2025)

**Kubelet Auto-Start Issue on T4 Nodes:**
- **Problem**: After rebooting T4 nodes to apply NVIDIA profiling config, kubelet didn't auto-start
- **Root Cause**: `systemctl enable kubelet` wasn't being called during node bootstrap
- **Temporary Fix**: Manually enabled and started kubelet on all 5 T4 nodes via SSH
- **Future**: Nodes should be terminated and recreated by ASG to get fresh bootstrap (user-data runs nodeadm which should enable kubelet)

**Decimal/Float Type Error in Lambda:**
- **Problem**: `unsupported operand type(s) for *: 'decimal.Decimal' and 'float'` error when allocating GPU resources
- **Root Cause**: DynamoDB returns numbers as `Decimal` type, but Lambda code was multiplying with Python floats
- **Fix**: Added `gpu_count = int(gpu_count)` at start of `get_pod_resource_limits()` and `get_pod_resource_requests()` functions
- **Location**: `terraform-gpu-devservers/lambda/reservation_processor/index.py:3034` and `:3117`

**NVIDIA Profiling Configuration:**
- **Problem 1**: Pods failed with "unsupported capabilities found in 'compute,profile,utility' (allowed 'compute,utility')"
  - Fix: Removed `profile` from `NVIDIA_DRIVER_CAPABILITIES`, kept only `compute,utility`
- **Problem 2**: Profiling failed with "driver resource unavailable" even with `CAP_PERFMON` and `CAP_SYS_PTRACE`
  - Fix: Changed to `CAP_SYS_ADMIN` which is required for NVIDIA GPU profiling (ncu, nsys)
- **Root Cause**: NVIDIA profiling tools need full SYS_ADMIN capability to access driver resources
- **Final Config**: `SYS_ADMIN` capability + node-level `NVreg_RestrictProfilingToAdminUsers=0`
- **Location**: `terraform-gpu-devservers/lambda/reservation_processor/index.py:4000` and `:3984`

**No Persistent Disk Flag (Oct 8, 2025):**
- **Problem**: When user created 2nd reservation and confirmed "continue without persistent disk", Lambda waited 60s for disk detachment, timed out, set status to "failed", but then CONTINUED execution and restored from snapshot anyway
- **Root Cause 1**: The timeout logic at line 305 raised `RuntimeError` which was caught by outer try-except block at line 2108, but `persistent_volume_id` variable remained set from earlier operations, so pod creation still used a persistent disk
- **Root Cause 2**: Exception handler at line 2275 only set `use_persistent_disk = False` but didn't clear `persistent_volume_id`, so any disk created/restored before the exception would still be attached to the pod
- **Fix Part 1 - Explicit Flag**: Added `no_persistent_disk` flag that flows from CLI through SQS to Lambda
  - CLI: When user confirms to continue without persistent disk, sets `no_persistent_disk=True` in SQS message
  - Lambda: Checks `no_persistent_disk` flag early (line 2087-2090) and skips ALL persistent disk logic if true
  - Files: `cli-tools/gpu-dev-cli/gpu_dev_cli/cli.py:914`, `reservations.py:396,450,487,544`, `lambda/reservation_processor/index.py:2087-2090`
- **Fix Part 2 - Exception Cleanup**: Updated exception handler at line 2275 to properly clean up state
  - Sets `persistent_volume_id = None` to clear any volume created before the error
  - Sets `is_new_disk = True` so EmptyDir gets proper shell environment setup
  - Location: `lambda/reservation_processor/index.py:2279-2280`
- **Benefit**: No more waiting for disk detachment, no snapshot restoration, clean EmptyDir volume from the start. Even if disk operations fail mid-way, exception handler ensures no disk is attached.

### 📋 Remaining Tasks

- **FQDN for devservers** - Set up proper domain names for development server access
- **Automated SSH config per reservation** - ✅ DONE - Each reservation now gets `~/.devgpu/<reservation_id>-sshconfig` file, use with `ssh -F ~/.devgpu/<reservation_id>-sshconfig <pod_name>`
- **Custom Docker image scaffold** - Create Dockerfile with pre-installed packages (Jupyter, etc.)
- **Add Docker CI image run** - allow user to specify gpu-dev ci-debug <testurl> that downloads that docker-image and goes for it
- **Increase /dev/shm for NCCL** - Bump /dev/shm space from 64MB for NCCL requirements (https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting.html#docker)
- **Add nvcuvid.so support** - Enable NCU (NVIDIA Nsight Compute) support with nvcuvid.so library

- **Make gpu-type case agnostic** - Allow case-insensitive GPU type parameters (e.g., h100, H100, HuNdred should all work)
- **Error on non-existing GPU type** - Error out if people ask for a non-existing GPU type
- **Error on too many GPUs** - Error out if people ask for more GPUs than available in node (8 for H100/B200, 4 for T4, etc.)
- **Fix GPU SKU validation** - Add proper error handling for non-existing/unavailable GPU types (e.g., user requesting A100 when only T4 available should get immediate error, not pending pod that will never schedule)
- **Set HuggingFace cache location** - Set HF_HOME or XDG_CACHE_HOME to /tmp or /workspace so HuggingFace doesn't fill up user home directories with model downloads
- **Add verbose CLI output** - More detailed status and progress information for debugging
- **Interactive CLI for cancel/edit** - Make `gpu-dev cancel` and `gpu-dev edit` interactive when no reservation ID specified - show list with up/down arrow selection
- **Default reservation edit/cancel** - Auto-select reservation if user only has one active
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
- **Switch between H100/B200 GPU types** - Add `--gpu-type=b200` CLI option with separate queues per GPU type
- **GPU queue status command** - Add status command to show queue length per GPU type (eg, `gpu-dev queue-status`)
- **Jupyter notebook integration** - Add `--jupyter` flag to enable Jupyter notebook and TensorBoard access
- **Add user collaboration feature** - Add `--add-user <github_name>` flag to allow users to add someone to the server
- **Display Bug:** - CLI shows "G6" instead of "L4" in availability table - likely resolves on prod release when Lambda functions are updated with new GPU type mappings
- **Fix extend command warning cleanup** - When using `--extend`, the system doesn't remove the WARN_EXPIRES_IN_5MIN.txt file and doesn't reset the expiry warning tracking in the database. Need to either clear the warning state from the table or keep warning history elsewhere for auditing purposes
- **Max reservation time: 48 hours** - Maximum reservation duration is 48 hours (initial 24h + one 24h extension allowed)
- **Scale up T4 instances** - Add 3 more T4 nodes (g4dn.12xlarge) to cluster
- **Scale up L4 instances** - Add 3 more L4 nodes (g6.12xlarge) to cluster
- **Add on-demand H100/H200/B200 capacity** - Add at least 2 nodes each of H100 (p5.48xlarge), H200 (p5e.48xlarge), and B200 (p6-b200.48xlarge) as on-demand capacity in addition to existing reserved instances
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

- Python CLI with config at `~/.config/gpu-dev/config.json`
- Commands: `reserve`, `list`, `config`
- Real-time polling until reservation is ready
