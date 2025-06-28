# Agent notes

the first part of this doc is the devs description of the repo. Everything under the 'AGENT SECTION' is for you, the agent, to update state, tricky things, what we're working on and more.
This will help both you, the agent, but also other agents down the road that share the responsibility of this repo management to navigate the repo.

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


## Tasks to execute
- ✅ figure out how the NIC works in AWS - EFA research completed, single AZ cluster placement groups required
- ✅ tf scaffold with ec2 / k8s / figuring out the total architecture diagram - ARCHITECTURE CONFIRMED
- 🏗️ make terraform scaffold for us-east-2 region with 5x p5.48xlarge + EKS + networking
- 🏗️ make a cli tool (python AND rust) to be able to reserve servers 
- 🏗️ implement SQS + EventBridge + Lambda queue processing system
- 🏗️ implement GitHub auth with metamates group verification
- 🏗️ implement DynamoDB state tracking for reservations

## Final Architecture Plan

**Infrastructure (us-east-2):**
- 5x p5.48xlarge instances (8 H100 GPUs each = 40 total GPUs)
- Cluster placement group for optimal networking with EFA
- EKS cluster with GPU-optimized node groups
- VPC with single AZ for EFA requirements

**Queue System:**
- SQS queue for reservation requests
- EventBridge triggers Lambda processor
- DynamoDB for state management (servers, reservations, quotas)
- Lambda handles allocation logic and K8s pod scheduling

**GPU Allocation:**
- K8s pods with fractional GPU allocation (1/2/4/8 GPUs per pod)
- Reservation time limits with auto-cleanup
- Support for multi-server (2x8 GPU) reservations

**Auth & CLI:**
- GitHub-based auth with metamates group verification
- Both Python and Rust CLI tools for dev choice comparison
- Public key management for server access
