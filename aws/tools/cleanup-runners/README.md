# clear-offline-runners

A Rust CLI tool for cleaning up orphaned AWS EC2 instances that are no longer registered as GitHub self-hosted runners.

## Overview

This tool helps maintain clean AWS environments by identifying and terminating EC2 instances that were created as GitHub self-hosted runners but are no longer registered with GitHub. It compares the list of GitHub runners in an organization with EC2 instances matching a specific name pattern and terminates instances that don't have corresponding GitHub runners.

## Features

- **Dry-run mode**: Preview which instances would be terminated without actually terminating them (enabled by default)
- **Organization support**: Works with GitHub organizations to get self-hosted runners
- **Batch processing**: Efficiently terminates instances in batches with rate limiting
- **Progress reporting**: Shows detailed results of the cleanup operation
- **Multi-region support**: Specify which AWS region to operate in

## Usage

### Basic usage (dry-run mode)
```bash
cargo run -- pytorch
```

### Terminate orphaned runners in us-west-2
```bash
cargo run -- pytorch --region us-west-2 --dry-run false
```

### Command-line options

- `organization` (required): GitHub organization name (e.g., "pytorch")
- `--region` (default: `us-east-1`): AWS region to search for EC2 instances
- `--dry-run` (default: `true`): If true, will not terminate any instances, just show what would be terminated
- `--runner-name` (default: `gh-ci-action-runner`): EC2 instance name pattern to filter for
- `--github-token`: GitHub token (can also be set via GITHUB_TOKEN environment variable)

## Prerequisites

- Rust toolchain installed
- AWS credentials configured (via AWS CLI, environment variables, or IAM roles)
- GitHub token with appropriate permissions for the organization
- Appropriate AWS permissions for EC2 operations:
  - `ec2:DescribeInstances`
  - `ec2:TerminateInstances`

## Building

```bash
cargo build --release
```

## Running tests

```bash
cargo test
```

## Safety

- **Dry-run by default**: The tool defaults to dry-run mode to prevent accidental terminations
- **Explicit confirmation required**: You must explicitly set `--dry-run false` to perform actual terminations
- **Detailed logging**: Shows exactly which instances will be or were processed

## Architecture

The tool is structured with the following modules:

- `main.rs`: CLI argument parsing and application entry point
- `lib.rs`: Core cleanup logic and public API
- `github_client.rs`: GitHub API client wrapper
- `ec2_client.rs`: AWS EC2 client wrapper
- `filter.rs`: Logic to find orphaned instances
- `cleanup.rs`: Instance termination logic with batch processing

The code uses dependency injection and traits to enable comprehensive testing with mock objects. 