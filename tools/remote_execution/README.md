# Blast CLI

Remote execution CLI for running multi-step jobs on Kubernetes.

## Prerequisites

- Python 3.9+
- AWS CLI (`aws`) — installed and configured with SSO admin role or SSO gpu role

## Quick Start

```bash
chmod +x setup.sh
./setup.sh
source ~/.blast-venv/bin/activate

# Run a single step with pure command
blast run --script "echo hello" --type cpu-44 --raw --follow

# Run multi-step with predefined json input
blast run-steps --config demo_script/simple/multi_run_simple.json --follow
```

This will:
1. Create a virtual environment at `~/.blast-venv`
2. Install the Blast CLI (`pip install -e blast/`)
3. Configure `~/.kube/config` for the EKS cluster
4. Verify the installation

## Usage
### Run a single step

```bash
blast run --script build.sh --type cpu-44 --follow
blast run --script "echo hello" --type cpu-44 --raw --follow
```

### Run multiple steps
```bash
blast run-steps \
    --step build --script demo_script/simple/build_demo.sh --type cpu-44 \
    --step test --script demo_script/simple/test_demo.sh --type cpu-44 \
    --follow
```

### Run from JSON config
example with run config
```bash
# Single step
blast run --config demo_script/simple/single_run.json --follow

# Multi step
blast run-steps --config demo_script/simple/multi_run_simple.json --follow
```

### Dry run (preview without submitting)
```bash
blast run-steps --step build --script build.sh --type cpu-44 --dry-run
```

### Check status

```bash
# Run status (all tasks)
blast status <run_id>

# Run status with detailed task history
blast status <run_id> --detail

# Single task status
blast task-status <task_id>
```

### Stream logs

```bash
# Stream all steps in a run
blast stream <run_id>

# Stream a single task
blast stream <task_id> --task
```

### JSON output

Use `--json` flag (before the command) for machine-readable output. Useful for scripting and AI agents.

```bash
# JSON output for any command
blast --json status <run_id>
blast --json status <run_id> --detail
blast --json task-status <task_id>
blast --json history
blast --json cancel <run_id>

# JSON output for run submission (returns run_id + task info)
blast --json run-steps --config demo_script/simple/multi_run_simple.json

# JSON output for dry-run (returns job_info + task_requests)
blast --json run-steps --step build --script build.sh --type cpu-44 --dry-run
```

Note: `--json` must be placed before the subcommand (e.g. `blast --json status`, not `blast status --json`).

### Other commands

```bash
blast history                 # Show your local run history
blast cancel <run_id>         # Cancel a run
```

## Project Structure

```
remote_execution/
├── setup.sh                 # Setup script
├── demo_script/             # Demo scripts and JSON configs
│   ├── simple/              # Hello-world demos
│   │   ├── build_demo.sh
│   │   ├── test_demo.sh
│   │   ├── minikube_demo.sh
│   │   ├── single_run.json
│   │   └── multi_run_simple.json
│   ├── pt/                  # PyTorch build & test
│   │   ├── pt_build.sh
│   │   ├── pt_test.sh
│   │   ├── run_code.sh
│   │   └── multi_run.json
│   ├── vllm/                # vLLM CI test reproduction
│   │   ├── vllm-test.sh
│   │   └── blast_command
│   ├── other/               # Misc examples
│   │   └── re_patch_example_g6.sh
│   └── configs/             # Shared/test configs
│       ├── multi_run_raw.json
│       └── test_error.json
└── blast/                   # Blast CLI package
    ├── pyproject.toml
    └── src/re_cli/
        ├── main.py          # CLI commands
        ├── cli_helper.py    # Shared CLI logic
        └── core/            # Core logic (reusable by other CLIs)
            ├── core_types.py
            ├── job_runner.py
            ├── artifacts.py
            ├── k8s_client.py
            ├── log_stream.py
            ├── git_helper.py
            ├── git_patch.py
            └── script_builder/
```

## DEBUG
make sure this works:

```bash
aws eks update-kubeconfig --name pytorch-re-prod-production --region us-east-2
```
this should create a ~/.kube/config file with the right cluster
if not, your aws auth is probably not setup correctly
