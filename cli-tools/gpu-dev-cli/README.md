# GPU Developer CLI

A command-line tool for reserving and managing PyTorch GPU development servers.

## Features

- 🚀 Reserve 1, 2, or 4 GPUs (T4s for testing, H100s for production)
- 📋 List and manage your reservations  
- 🔐 GitHub authentication with SSH key injection
- 📊 View cluster status and availability
- ⚡ Built on AWS EKS with Kubernetes pods

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

Configure your GitHub username for SSH key fetching:

```bash
# Set your GitHub username (required for SSH access)
gpu-dev config set github_user your-github-username

# View current configuration
gpu-dev config show
```

Configuration is stored at `~/.gpu-dev-config`:

```json
{
  "github_user": "your-github-username"
}
```

**AWS Configuration**: The CLI uses your AWS credentials and automatically discovers the infrastructure resources.

## Usage

### Reserve GPUs

```bash
# Reserve 1 GPU for 8 hours (default)
gpu-dev reserve

# Reserve 2 GPUs for 4 hours  
gpu-dev reserve --gpus 2 --hours 4

# Reserve 4 GPUs for 12 hours with a name
gpu-dev reserve --gpus 4 --hours 12 --name "multi-gpu-training"
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

### Connect to Your Server

Once your reservation is active, you'll get an SSH command:

```bash
# Example output from successful reservation:
✅ Reservation complete!
📋 Reservation ID: abc12345-1234-5678-9abc-def012345678
🕐 Valid for: 4 hours
💻 Connect with: ssh -p 30508 dev@3.17.78.115
```

Just copy and paste the SSH command to connect!

### List Reservations

```bash
# List your active reservations
gpu-dev list
```

## GPU Options

**Testing Environment (g4dn.12xlarge instances):**
- **1 GPU**: Single T4 for development  
- **2 GPUs**: Dual T4 setup
- **4 GPUs**: Full g4dn.12xlarge instance (4x T4)

**Production Environment (planned - p5.48xlarge instances):**
- **8 GPUs**: Full p5.48xlarge instance (8x H100)

## Authentication

The CLI requires:

1. **AWS credentials** configured (via `aws configure` or IAM role)
2. **GitHub username** configured (for SSH key fetching): `gpu-dev config set github_user your-username`
3. **Public SSH key** on your GitHub profile (used for server access)


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

- **SQS Queue**: For async reservation processing
- **DynamoDB**: For reservation and server state tracking
- **Lambda Functions**: For pod creation and management
- **EKS Cluster**: For GPU pod scheduling
- **GitHub API**: For SSH public key fetching