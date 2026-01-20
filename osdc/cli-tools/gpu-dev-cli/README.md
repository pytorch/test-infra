# GPU Developer CLI

A command-line tool for reserving and managing GPU development servers on AWS EKS.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Quick Start](#quick-start)
- [Commands Reference](#commands-reference)
- [GPU Types](#gpu-types)
- [Storage](#storage)
- [Multinode Reservations](#multinode-reservations)
- [Custom Docker Images](#custom-docker-images)
- [Nsight Profiling](#nsight-profiling)
- [Default Container Image](#default-container-image)
- [SSH & IDE Integration](#ssh--ide-integration)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

---

## Installation

```bash
# Install directly from GitHub (recommended)
python3 -m pip install --upgrade "git+https://github.com/wdvr/osdc.git"

# Or install from local clone
git clone https://github.com/wdvr/osdc.git
cd osdc
pip install -e .
```

## Configuration

### Initial Setup

```bash
# Set your GitHub username (required for SSH key authentication)
gpu-dev config set github_user your-github-username

# View current configuration
gpu-dev config show
```

Configuration is stored at `~/.config/gpu-dev/config.json`.

### SSH Config Integration

Enable automatic SSH config for seamless VS Code/Cursor integration:

```bash
# Enable SSH config auto-include (recommended)
gpu-dev config ssh-include enable

# Disable if needed
gpu-dev config ssh-include disable
```

When enabled, this adds `Include ~/.gpu-dev/*-sshconfig` to:
- `~/.ssh/config`
- `~/.cursor/ssh_config`

### AWS Authentication

The CLI uses your AWS credentials. Configure via:
- `aws configure` command
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- IAM roles (for EC2/Lambda)
- SSO: `aws sso login --profile your-profile`

---

## Quick Start

```bash
# Interactive reservation (guided setup)
gpu-dev reserve

# Reserve 4 H100 GPUs for 8 hours
gpu-dev reserve --gpu-type h100 --gpus 4 --hours 8

# Check your reservations
gpu-dev list

# Connect to your active reservation
gpu-dev connect

# Check GPU availability
gpu-dev avail
```

---

## Commands Reference

### `gpu-dev reserve`

Create a GPU reservation.

**Interactive Mode** (default when parameters omitted):
```bash
gpu-dev reserve
```
Guides you through GPU type, count, duration, disk, and Jupyter selection.

**Command-line Mode**:
```bash
gpu-dev reserve [OPTIONS]
```

| Option | Short | Description |
|--------|-------|-------------|
| `--gpus` | `-g` | Number of GPUs (1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48) |
| `--gpu-type` | `-t` | GPU type: `b200`, `h200`, `h100`, `a100`, `a10g`, `t4`, `l4`, `t4-small`, `cpu-arm`, `cpu-x86` |
| `--hours` | `-h` | Duration in hours (0.0833 to 24, supports decimals) |
| `--name` | `-n` | Optional reservation name |
| `--jupyter` | | Enable Jupyter Lab access |
| `--disk` | | Named persistent disk to use, or `none` for temporary storage |
| `--no-persist` | | Create without persistent disk (ephemeral `/home/dev`) |
| `--ignore-no-persist` | | Skip warning when disk is in use |
| `--recreate-env` | | Recreate shell environment on existing disk |
| `--distributed` | `-d` | Required for multinode reservations (>8 GPUs) |
| `--dockerfile` | | Path to custom Dockerfile (max 512KB) |
| `--dockerimage` | | Custom Docker image URL |
| `--preserve-entrypoint` | | Keep original container ENTRYPOINT/CMD |
| `--node-label` | `-l` | Node selector labels (e.g., `--node-label nsight=true`) |
| `--verbose` | `-v` | Enable debug output |
| `--no-interactive` | | Force non-interactive mode |

**Examples**:
```bash
# 2 H100 GPUs for 4 hours with Jupyter
gpu-dev reserve -t h100 -g 2 -h 4 --jupyter

# Use specific persistent disk
gpu-dev reserve -t a100 -g 4 -h 8 --disk pytorch-dev

# Temporary storage only
gpu-dev reserve -t t4 -g 1 -h 2 --disk none

# 16 GPUs across 2 nodes (multinode)
gpu-dev reserve -t h100 -g 16 -h 12 --distributed

# Custom Docker image
gpu-dev reserve -t h100 -g 4 --dockerimage pytorch/pytorch:2.3.0-cuda12.1-cudnn8-devel

# Request Nsight profiling node
gpu-dev reserve -t h100 -g 8 --node-label nsight=true
```

### `gpu-dev list`

List your reservations.

```bash
gpu-dev list [OPTIONS]
```

| Option | Short | Description |
|--------|-------|-------------|
| `--user` | `-u` | Filter by user (`all` for all users) |
| `--status` | `-s` | Filter by status: `active`, `queued`, `pending`, `preparing`, `expired`, `cancelled`, `failed` |
| `--all` | `-a` | Show all reservations (including expired/cancelled) |
| `--watch` | | Continuously refresh every 2 seconds |

### `gpu-dev show`

Show detailed information for a specific reservation.

```bash
gpu-dev show [RESERVATION_ID]
```

If no ID provided, shows details for your active/pending reservation.

### `gpu-dev connect`

SSH to your active reservation.

```bash
gpu-dev connect [RESERVATION_ID]
```

If no ID provided, connects to your active reservation.

### `gpu-dev cancel`

Cancel a reservation.

```bash
gpu-dev cancel [RESERVATION_ID]
```

**Interactive Mode**: If no ID provided, shows selection menu.

| Option | Short | Description |
|--------|-------|-------------|
| `--all` | `-a` | Cancel all your active reservations |

### `gpu-dev edit`

Modify an active reservation.

```bash
gpu-dev edit [RESERVATION_ID] [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--enable-jupyter` | Enable Jupyter Lab |
| `--disable-jupyter` | Disable Jupyter Lab |
| `--extend` | Extend reservation duration |
| `--add-user` | Add secondary user (GitHub username) |

**Examples**:
```bash
# Enable Jupyter on existing reservation
gpu-dev edit abc12345 --enable-jupyter

# Extend reservation
gpu-dev edit abc12345 --extend

# Add collaborator
gpu-dev edit abc12345 --add-user colleague-github-name
```

### `gpu-dev avail`

Check GPU availability by type.

```bash
gpu-dev avail [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--watch` | Continuously refresh every 5 seconds |

### `gpu-dev status`

Show overall cluster status and capacity.

```bash
gpu-dev status
```

### `gpu-dev disk`

Manage persistent disks.

#### `gpu-dev disk list`
```bash
gpu-dev disk list [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--watch` | Continuously refresh every 2 seconds |
| `--user` | Impersonate another user |

Shows: disk name, size, created date, last used, snapshot count, status (available/in-use/backing-up/deleted).

#### `gpu-dev disk create`
```bash
gpu-dev disk create <DISK_NAME>
```
Creates a new named persistent disk. Disk names can contain letters, numbers, hyphens, and underscores.

#### `gpu-dev disk delete`
```bash
gpu-dev disk delete <DISK_NAME> [--yes/-y]
```
Soft-deletes a disk. Snapshots are permanently deleted after 30 days.

#### `gpu-dev disk list-content`
```bash
gpu-dev disk list-content <DISK_NAME>
```
Shows file listing from the latest snapshot of a disk.

#### `gpu-dev disk rename`
```bash
gpu-dev disk rename <OLD_NAME> <NEW_NAME>
```
Renames an existing disk.

### `gpu-dev help`

Show help information.

---

## GPU Types

| GPU Type | Instance Type | GPUs/Node | Memory/GPU | Best For |
|----------|--------------|-----------|------------|----------|
| `b200` | p6-b200.48xlarge | 8 | 192GB | Latest NVIDIA Blackwell, highest performance |
| `h200` | p5e.48xlarge | 8 | 141GB | Large models, high memory workloads |
| `h100` | p5.48xlarge | 8 | 80GB | Production training, large-scale inference |
| `a100` | p4d.24xlarge | 8 | 40GB | General ML training |
| `a10g` | g5.12xlarge | 4 | 24GB | Inference, smaller training |
| `l4` | g6.12xlarge | 4 | 24GB | Inference, cost-effective |
| `t4` | g4dn.12xlarge | 4 | 16GB | Development, testing |
| `t4-small` | g4dn.xlarge | 1 | 16GB | Single GPU development |
| `cpu-arm` | c7g.4xlarge | 0 | N/A | ARM CPU-only workloads |
| `cpu-x86` | c7i.4xlarge | 0 | N/A | x86 CPU-only workloads |

---

## Storage

### Persistent Disk (EBS) - `/home/dev`

Each user can have **named persistent disks** that preserve data between sessions:

- **Mount point**: `/home/dev` (your home directory)
- **Size**: 100GB per disk
- **Backed up**: Automatic snapshots when reservation ends
- **Content tracking**: View contents via `gpu-dev disk list-content`

**Workflow**:
```bash
# Create a new disk
gpu-dev disk create my-project

# Use it in a reservation
gpu-dev reserve --disk my-project

# List your disks
gpu-dev disk list

# View disk contents (from snapshot)
gpu-dev disk list-content my-project
```

**Multiple Disks**: You can have multiple named disks for different projects (e.g., `pytorch-dev`, `llm-training`, `experiments`).

**Disk Selection**: During interactive reservation, you'll be prompted to select a disk or create a new one.

### Shared Personal Storage (EFS) - `/shared-personal`

Per-user EFS filesystem for larger files that persist across all your reservations:

- **Mount point**: `/shared-personal`
- **Size**: Elastic (pay for what you use)
- **Use case**: Datasets, model checkpoints, large files

### Shared ccache (EFS) - `/ccache`

Shared compiler cache across ALL users:

- **Mount point**: `/ccache`
- **Environment**: `CCACHE_DIR=/ccache`
- **Benefit**: Faster compilation for PyTorch and other C++ projects
- **Shared**: Cache hits from any user benefit everyone

### Temporary Storage

Use `--disk none` or `--no-persist` for reservations without persistent disk:
- `/home/dev` uses ephemeral storage
- Data is lost when reservation ends
- Useful for quick experiments or CI-like workflows

---

## Multinode Reservations

For distributed training across multiple GPU nodes:

```bash
# 16 H100 GPUs (2 nodes x 8 GPUs)
gpu-dev reserve -t h100 -g 16 --distributed

# 24 H100 GPUs (3 nodes x 8 GPUs)
gpu-dev reserve -t h100 -g 24 --distributed
```

**Requirements**:
- GPU count must be a multiple of GPUs-per-node (e.g., 16, 24, 32 for H100)
- `--distributed` flag is required

**What you get**:
- Multiple pods with hostname resolution: `<podname>-headless.gpu-dev.svc.cluster.local`
- Shared network drive between nodes
- Network connectivity between all pods
- Master port 29500 available on all nodes
- EFA (Elastic Fabric Adapter) for high-bandwidth inter-node communication

**Node naming**: Nodes are numbered 0 to N-1. Use `$RANK` or node index to set `MASTER_ADDR`.

---

## Custom Docker Images

### Using a Pre-built Image

```bash
gpu-dev reserve --dockerimage pytorch/pytorch:2.3.0-cuda12.1-cudnn8-devel
```

Note: The image must have SSH server capabilities for remote access.

### Using a Custom Dockerfile

```bash
gpu-dev reserve --dockerfile ./my-project/Dockerfile
```

**Limitations**:
- Dockerfile max size: 512KB
- Build context (directory) max size: ~700KB compressed
- Build happens at reservation time (adds startup time)

**Example Dockerfile**:
```dockerfile
FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-devel

# Install additional packages
RUN pip install transformers datasets accelerate

# Your customizations...
```

### Preserving Entrypoint

To keep the original container's ENTRYPOINT/CMD instead of the SSH server:

```bash
gpu-dev reserve --dockerimage myimage:latest --preserve-entrypoint
```

---

## Nsight Profiling

For GPU profiling with NVIDIA Nsight Compute (ncu) and Nsight Systems (nsys):

```bash
# Request a profiling-dedicated node
gpu-dev reserve -t h100 -g 8 --node-label nsight=true
```

**Why dedicated nodes?**
- DCGM (GPU monitoring) conflicts with Nsight profiling
- Profiling-dedicated nodes have DCGM disabled
- One H100, one B200, and one T4 node are reserved for profiling

**Profiling capabilities enabled**:
- `CAP_SYS_ADMIN` Linux capability on pods
- `NVreg_RestrictProfilingToAdminUsers=0` on nodes
- `NVIDIA_DRIVER_CAPABILITIES=compute,utility`

**Available profiling tools**:
- `ncu` - Nsight Compute for kernel profiling
- `nsys` - Nsight Systems for system-wide profiling

---

## Default Container Image

The default image (`pytorch/pytorch:2.9.1-cuda12.8-cudnn9-devel` based) includes:

### Pre-installed Software

**Deep Learning**:
- PyTorch 2.9.1 with CUDA 12.8
- cuDNN 9
- CUDA Toolkit 12.8 + 13.0

**Python Packages**:
- JupyterLab, ipywidgets
- matplotlib, seaborn, plotly
- pandas, numpy, scikit-learn
- tensorboard

**System Tools**:
- zsh with oh-my-zsh (default shell)
- bash with bash-completion
- vim, nano, neovim
- tmux, htop, tree
- git, curl, wget
- ccache

**Development**:
- Claude Code CLI (`claude`)
- Node.js 20
- SSH server

### Shell Environment

- **Default shell**: zsh with oh-my-zsh
- **Plugins**: zsh-autosuggestions, zsh-syntax-highlighting
- **User**: `dev` with passwordless sudo
- **Home**: `/home/dev` (persistent or temporary based on disk settings)

### Environment Variables

```bash
CUDA_12_PATH=/usr/local/cuda-12.8
CUDA_13_PATH=/usr/local/cuda-13.0
CCACHE_DIR=/ccache
```

---

## SSH & IDE Integration

### SSH Access

After reservation is active:

```bash
# Quick connect
gpu-dev connect

# Or use the SSH command shown in reservation details
ssh dev@<node-ip> -p <nodeport>

# With SSH config enabled (recommended)
ssh <pod-name>
```

### VS Code Remote

With SSH config enabled:
```bash
code --remote ssh-remote+<pod-name> /home/dev
```

Or click the VS Code link shown in `gpu-dev show` output.

### Cursor IDE

Works the same as VS Code when SSH config is enabled:
1. Open Remote SSH in Cursor
2. Select your pod from the list

### SSH Agent Forwarding

To use your local SSH keys on the server (e.g., for git):
```bash
ssh -A <pod-name>
```

Or add to your SSH config:
```
Host gpu-dev-*
    ForwardAgent yes
```

---

## Reservation Limits

| Limit | Value |
|-------|-------|
| Maximum duration | 24 hours |
| Minimum duration | 5 minutes (0.0833 hours) |
| Extension | Once, up to 24 additional hours |
| Total max time | 48 hours (24h initial + 24h extension) |

**Expiry Warnings**:
- 30 minutes before expiry
- 15 minutes before expiry
- 5 minutes before expiry

Warnings appear as files in your home directory and via `wall` messages.

---

## Architecture

### System Components

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  GPU Dev    │────▶│  SQS Queue   │────▶│  Lambda Processor   │
│    CLI      │     │              │     │                     │
└─────────────┘     └──────────────┘     └──────────┬──────────┘
       │                                            │
       │                                            ▼
       │            ┌──────────────┐     ┌─────────────────────┐
       └───────────▶│  DynamoDB    │◀────│    EKS Cluster      │
                    │ Reservations │     │   (GPU Nodes)       │
                    └──────────────┘     └─────────────────────┘
```

### Infrastructure

- **EKS Cluster**: Kubernetes cluster with GPU-enabled nodes
- **Node Groups**: Auto-scaling groups per GPU type
- **NVIDIA GPU Operator**: Manages GPU drivers and device plugin
- **EBS CSI Driver**: Handles persistent volume attachments
- **EFS**: Shared storage for personal files and ccache

### Networking

- **SSH Access**: Via NodePort services (30000-32767)
- **Inter-node**: EFA (Elastic Fabric Adapter) for multinode
- **DNS**: Pod hostname resolution via headless services
- **Internet**: Full outbound access from pods

---

## Troubleshooting

### Common Issues

**"Disk is in use"**:
- Your disk is attached to another reservation
- Cancel the other reservation or use `--disk none`
- Check: `gpu-dev disk list`

**"Queued" status**:
- No GPU capacity available
- Wait for queue position to advance
- Check availability: `gpu-dev avail`

**SSH connection refused**:
- Pod may still be starting
- Wait for status to become "active"
- Check: `gpu-dev show <id>`

**Pod stuck in "preparing"**:
- Image pull may be slow (especially for custom images)
- Disk attachment may take time
- Check detailed status: `gpu-dev show <id>`

### Debugging Commands

```bash
# Show detailed reservation info
gpu-dev show <reservation-id>

# Watch reservation status
gpu-dev list --watch

# Check cluster status
gpu-dev status

# View disk contents
gpu-dev disk list-content <disk-name>
```

### Getting Help

- Use `gpu-dev help` or `gpu-dev <command> --help`
- Report issues: https://github.com/anthropics/claude-code/issues

---

## Development

```bash
# Install development dependencies
poetry install --with dev

# Run tests
poetry run pytest

# Format code
poetry run black .
poetry run isort .

# Type checking
poetry run mypy .
```
