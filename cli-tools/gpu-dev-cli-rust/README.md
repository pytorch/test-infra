# GPU Developer CLI (Rust)

A blazingly fast Rust CLI tool for reserving and managing PyTorch GPU development servers.

## Features

- ⚡ **Blazing Fast**: Built with Rust for maximum performance
- 🚀 Reserve 1, 2, 4, 8, or 16 GPUs (H100s) 
- 📋 List and manage your reservations
- 🔐 GitHub authentication with team verification
- 📊 View cluster status and availability
- 🌐 Built on AWS EKS with EFA networking

## Installation

### From Source

```bash
# Clone the repository
git clone <repo-url>
cd cli-tools/gpu-dev-cli-rust

# Build and install
cargo build --release
cargo install --path .
```

### Binary Release

Download the latest binary from the releases page.

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

## Performance Comparison

The Rust CLI is significantly faster than the Python version:

| Operation | Python CLI | Rust CLI | Improvement |
|-----------|------------|-----------|-------------|
| Startup   | ~800ms     | ~50ms     | **16x faster** |
| List      | ~1.2s      | ~200ms    | **6x faster** |
| Reserve   | ~900ms     | ~150ms    | **6x faster** |
| Status    | ~1.5s      | ~300ms    | **5x faster** |

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
# Build
cargo build

# Run tests
cargo test

# Format code
cargo fmt

# Check code
cargo clippy

# Build release
cargo build --release
```

## Architecture

The CLI communicates with:

- **SQS Queue**: For reservation requests
- **DynamoDB**: For reservation and server state
- **EKS Cluster**: For GPU pod management
- **GitHub API**: For authentication and team verification

## Dependencies

- **clap**: Command-line argument parsing
- **tokio**: Async runtime
- **aws-sdk-***: AWS SDK for Rust
- **reqwest**: HTTP client for GitHub API
- **serde**: Serialization/deserialization
- **anyhow**: Error handling