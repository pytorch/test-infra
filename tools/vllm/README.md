# vLLM Buildkite CI Failure Reporter

Fetches the latest Buildkite CI build for a given branch, extracts all failed steps with failure reasons, and provides direct links to the relevant log lines.

## Usage

```bash
python3 fetch_failures.py --branch <BRANCH> --token <BUILDKITE_TOKEN>
```

### Arguments

| Flag | Required | Description |
|------|----------|-------------|
| `--branch` | Yes | Buildkite branch name, e.g. `atalman:release_212_tests` |
| `--token` | Yes | Buildkite API token (create at https://buildkite.com/user/api-access-tokens, scope: `read_builds`) |
| `--save-local-logs` | No | Save raw logs for each failed job to local files |
| `--output-dir` | No | Directory for saved logs (default: current directory) |

### Examples

```bash
# Print failure report
python3 fetch_failures.py --branch "atalman:release_212_tests" --token "bkua_xxx"

# Print report + save raw logs locally
python3 fetch_failures.py --branch "atalman:release_212_tests" --token "bkua_xxx" --save-local-logs

# Save logs to a specific directory
python3 fetch_failures.py --branch "atalman:release_212_tests" --token "bkua_xxx" --save-local-logs --output-dir /tmp/logs
```

### Sample Output

```
======================================================================
Build #63095 | Branch: atalman:release_212_tests | State: failed
Message: [CI] Fix Dockerfile.cpu to resolve torch 2.12.0 from CPU test channel
Created: 2026-04-27T13:15:10.279Z
Failed steps: 13
======================================================================

  1. [Fusion E2E TP2 Quick (H100)]
    Log: https://buildkite.com/vllm/ci/builds/63095#019dcf15-7f55-...
    Local: /tmp/logs/build_63095/Fusion_E2E_TP2_Quick_H100.log
    - tests/compile/fusions_e2e/test_tp2_ar_rms.py::test_tp2_ar_rms_fp8_fusions[...] | RuntimeError: ...
      https://buildkite.com/vllm/ci/builds/63095#019dcf15-7f55-.../L1144
```

## How It Works

1. **Get latest build** -- queries Buildkite REST API for the most recent build on the given branch
2. **Get failed steps** -- fetches all steps with `hard_failed` outcome and their job IDs
3. **Extract failure reasons** -- fetches each failed job's log, parses `FAILED` lines from pytest output, and records the line number for deep linking
