# Workflow Dispatch Filters

## Overview

PyTorch CI workflows (`trunk.yml`, `pull.yml`) support optional filtering inputs for `workflow_dispatch` events. This allows autorevert to re-run only specific failed jobs and tests instead of the full CI suite.

## Workflow Dispatch Inputs

| Input | Type | Description |
|-------|------|-------------|
| `jobs-to-include` | string | Space-separated list of job display names to run (empty = all jobs) |
| `tests-to-include` | string | Space-separated list of test modules to run (empty = all tests) |

## Filter Value Derivation

Filter values are derived from Signal metadata during signal extraction.

### Job Names (`jobs-to-include`)

Derived from `Signal.job_base_name`. Job names follow two patterns:

| Pattern | Example | Filter Value |
|---------|---------|--------------|
| With ` / ` separator | `linux-jammy-cuda12.8-py3.10-gcc11 / test` | `linux-jammy-cuda12.8-py3.10-gcc11` |
| Without separator | `inductor-build` | `inductor-build` |

**More examples:**
- `linux-jammy-cuda12.8-py3.10-gcc11 / build` → `linux-jammy-cuda12.8-py3.10-gcc11`
- `linux-jammy-py3.10-gcc11` → `linux-jammy-py3.10-gcc11`
- `job-filter` → `job-filter`
- `get-label-type` → `get-label-type`

### Test Modules (`tests-to-include`)

Derived from `Signal.test_module` (set during signal extraction from test file path, without `.py` extension).

**Examples:**
- `test_torch`
- `test_nn`
- `distributed/elastic/multiprocessing/api_test`
- `distributed/test_c10d`

## Input Format Rules

### `jobs-to-include`
- Space-separated exact job **display names**
- Case-sensitive, must match exactly
- Examples:
  - Build/test jobs: `"linux-jammy-cuda12.8-py3.10-gcc11 linux-jammy-py3.10-gcc11"`
  - Standalone jobs: `"inductor-build job-filter get-label-type"`

### `tests-to-include`
- Space-separated test module paths (no `.py` extension)
- Module-level only (no `::TestClass::test_method`)
- Example: `"test_torch test_nn distributed/elastic/multiprocessing/api_test"`

## Behavior Notes

1. **Empty inputs** = run all jobs/tests (normal CI behavior)
2. **Filtered dispatch** = only matching jobs run; within those jobs, only matching tests run
3. **Test sharding** preserved - distributed tests still run on distributed shards
4. **TD compatibility** - TD is disabled for filtered test runs; only specified tests run
5. **Workflow support detection** - autorevert parses workflow YAML to check if inputs are supported before dispatch
