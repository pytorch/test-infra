# cleanup-ssm

A Rust CLI tool for cleaning up old AWS Systems Manager (SSM) parameters.

## Overview

This tool helps you identify and delete SSM parameters that are older than a specified number of days. It's designed to help maintain clean AWS environments by removing outdated parameters while providing safety features like dry-run mode.

## Features

- **Dry-run mode**: Preview which parameters would be deleted without actually deleting them (enabled by default)
- **Age-based filtering**: Delete parameters older than a specified number of days
- **Batch processing**: Efficiently processes parameters in batches
- **Progress reporting**: Shows detailed results of the cleanup operation
- **Multi-region support**: Specify which AWS region to operate in

## Usage

### Basic usage (dry-run mode)
```bash
cargo run
```

### Delete parameters older than 7 days in us-west-2
```bash
cargo run -- --region us-west-2 --older-than 7 --dry-run false
```

### Command-line options

- `--region` (default: `us-east-1`): AWS region to run the cleanup in
- `--dry-run` (default: `true`): If true, will not delete any parameters, just show what would be deleted
- `--older-than` (default: `1`): Number of days - parameters older than this will be deleted

## Prerequisites

- Rust toolchain installed
- AWS credentials configured (via AWS CLI, environment variables, or IAM roles)
- Appropriate AWS permissions for SSM operations:
  - `ssm:DescribeParameters`
  - `ssm:DeleteParameters`

## Building

```bash
cargo build --release
```

## Running tests

```bash
cargo test
```

## Safety

- **Dry-run by default**: The tool defaults to dry-run mode to prevent accidental deletions
- **Explicit confirmation required**: You must explicitly set `--dry-run false` to perform actual deletions
- **Detailed logging**: Shows exactly which parameters will be or were processed

## Architecture

The tool is structured with the following modules:

- `main.rs`: CLI argument parsing and application entry point
- `lib.rs`: Core cleanup logic and public API
- `client.rs`: AWS SSM client wrapper
- `cleanup.rs`: Parameter deletion logic with batch processing
- `filter.rs`: Age-based parameter filtering logic

The code uses dependency injection and traits to enable comprehensive testing with mock objects.