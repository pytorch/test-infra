# user-data-diff

A Rust CLI tool for comparing user_data between AWS Launch Template versions with automatic base64 and gzip decoding.

## Overview

This tool helps you visualize changes in launch template user_data scripts across different versions. It automatically handles base64 encoding and gzip compression commonly used in AWS launch templates, providing a clean diff view of the actual script content. The tool also detects when AWS changes encoding methods between versions (e.g., switching from plain base64 to gzip+base64 compression) even when the decoded content remains identical.

## Features

- **Automatic decoding**: Handles base64 and base64+gzip encoded user_data
- **Encoding detection**: Detects and reports when encoding methods differ between versions
- **Version comparison**: Compare any two versions or use defaults (latest vs previous)
- **Colored output**: Easy-to-read diff with syntax highlighting (can be disabled)
- **Multi-region support**: Specify which AWS region to operate in
- **Flexible template selection**: Use either template name or template ID

## Usage

### Basic usage (compare latest vs previous version)
```bash
cargo run -- --template-name my-launch-template
```

### Compare specific versions
```bash
cargo run -- --template-name my-launch-template --from-version 1 --to-version 3
```

### Use template ID instead of name
```bash
cargo run -- --template-id lt-1234567890abcdef0 --from-version 2 --to-version 4
```

### Specify region and disable colors
```bash
cargo run -- --region us-west-2 --template-name my-template --no-color
```

### Command-line options

- `--region` (default: `us-east-1`): AWS region to query launch templates from
- `--template-name`: Name of the launch template to compare (mutually exclusive with template-id)
- `--template-id`: ID of the launch template to compare (mutually exclusive with template-name)
- `--from-version`: Source version number (defaults to second-latest version)
- `--to-version`: Target version number (defaults to latest version)
- `--no-color`: Disable colored output for diff

## Prerequisites

- Rust toolchain installed
- AWS credentials configured (via AWS CLI, environment variables, or IAM roles)
- Appropriate AWS permissions for EC2 operations:
  - `ec2:DescribeLaunchTemplates`
  - `ec2:DescribeLaunchTemplateVersions`

## Building

```bash
cargo build --release
```

## Running tests

```bash
cargo test
```

## Examples

### Example 1: Basic comparison
```bash
$ cargo run -- --template-name web-server-template
Comparing launch template 'web-server-template' versions 1 → 2

- #!/bin/bash
- yum update -y
- yum install -y httpd
+ #!/bin/bash
+ yum update -y
+ yum install -y httpd nginx
+ systemctl enable nginx

Similarity: 75.0%
```

### Example 2: No differences
```bash
$ cargo run -- --template-name web-server-template --from-version 2 --to-version 2
Comparing launch template 'web-server-template' versions 2 → 2

No differences found.
```

### Example 3: Encoding differences
```bash
$ cargo run -- --template-name gh-ci-action-windows-runner --from-version 96 --to-version 97
Comparing launch template 'gh-ci-action-windows-runner' versions 96 → 97

User data content is identical, but encoding differs:

Version 96 encoding method:
  Plain Base64 encoding

Version 97 encoding method:
  Base64 + Gzip compression

Decoded content (identical):
No differences found.
```

## Architecture

The tool is structured with the following modules:

- `main.rs`: CLI argument parsing and application entry point
- `lib.rs`: Core diffing logic and public API
- `client.rs`: AWS EC2 client wrapper with async trait for testability
- `decoder.rs`: user_data decoding logic (base64 → optional gzip → plain text)
- `diff.rs`: Text diffing and colored output formatting

## Error Handling

The tool provides clear error messages for common scenarios:
- Template not found
- Invalid version numbers
- AWS permission errors
- Decoding failures (malformed base64 or gzip)
- Network connectivity issues