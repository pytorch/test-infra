# GPU Developer CLI

A command-line tool for reserving and managing PyTorch GPU development servers.

## Features

- 🚀 Reserve 1, 2, 4, 8, or 16 GPUs (H100s)
- 📋 List and manage your reservations
- 🔐 GitHub authentication with team verification
- 📊 View cluster status and availability
- ⚡ Built on AWS EKS with EFA networking

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd cli-tools/gpu-dev-cli

# Install with Poetry
poetry install

# Or install with pip
pip install -e .
```

## Configuration

Set up your configuration with environment variables:

```bash
export GPU_DEV_QUEUE_URL="https://sqs.us-east-2.amazonaws.com/..."
export GPU_DEV_RESERVATIONS_TABLE="pytorch-gpu-dev-reservations"
export GPU_DEV_SERVERS_TABLE="pytorch-gpu-dev-servers"
export GPU_DEV_CLUSTER_NAME="pytorch-gpu-dev-cluster"
export GITHUB_TOKEN="your_github_token"
```

Or create a config file at `~/.config/gpu-dev-cli/config.json`:

```json
{
  "aws_region": "us-east-2",
  "queue_url": "https://sqs.us-east-2.amazonaws.com/...",
  "reservations_table": "pytorch-gpu-dev-reservations",
  "servers_table": "pytorch-gpu-dev-servers",
  "cluster_name": "pytorch-gpu-dev-cluster"
}
```

## Usage

### Reserve GPUs

```bash
# Reserve 1 GPU for 8 hours (default)
gpu-dev reserve

# Reserve 4 GPUs for 12 hours
gpu-dev reserve --gpus 4 --hours 12

# Reserve 16 GPUs (2x8 setup) for 4 hours with a name
gpu-dev reserve --gpus 16 --hours 4 --name "distributed-training"

# Dry run to see what would be reserved
gpu-dev reserve --gpus 8 --dry-run
```

### List Reservations

```bash
# List all your reservations
gpu-dev list

# List reservations by user
gpu-dev list --user username

# List only active reservations
gpu-dev list --status active
```

### Manage Reservations

```bash
# Get connection info for a reservation
gpu-dev connect abc12345

# Cancel a reservation
gpu-dev cancel abc12345
```

### Cluster Status

```bash
# View overall cluster status
gpu-dev status

# View current configuration
gpu-dev config
```

## GPU Options

- **1 GPU**: Single H100 for development
- **2 GPUs**: Dual H100 setup
- **4 GPUs**: Quad H100 setup  
- **8 GPUs**: Full p5.48xlarge instance (8x H100)
- **16 GPUs**: 2x p5.48xlarge instances with EFA networking

## Authentication

The CLI requires:

1. GitHub personal access token with `repo` and `read:org` scopes
2. Membership in the `pytorch/metamates` team
3. Write access to the `pytorch/pytorch` repository

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

## Architecture

The CLI communicates with:

- **SQS Queue**: For reservation requests
- **DynamoDB**: For reservation and server state
- **EKS Cluster**: For GPU pod management
- **GitHub API**: For authentication and team verification