---
name: wheel-size-analyzer
description: Analyze PyTorch nightly wheel sizes over a date range using GitHub Actions artifacts API. Use when tracking binary size changes, identifying wheel size regressions, or producing wheel size reports for manywheel builds. Supports specifying CUDA version (cuda12_6, cuda12_8, cuda12_9, cuda13_0), CPU, XPU, or ROCm variants. Triggered by mentions of "wheel size", "binary size", "package size", "manywheel size", or "nightly build size".
---

# Wheel Size Analyzer

Tracks and reports PyTorch nightly wheel sizes over time by querying GitHub Actions artifact data. Identifies significant size increases and produces daily size reports.

## When to use this skill

Use when the user asks about:
- Wheel or binary size changes over a date range
- Identifying when wheel size regressions occurred
- Comparing wheel sizes across nightly builds
- Producing size reports for manywheel build variants

## Instructions

### Step 1: Determine parameters

Collect three parameters from the user. If they provide a CUDA version (e.g., "cuda 12.8", "CUDA 13.0", "cu128"), map it to the artifact name. If a parameter is not specified, ask or use the default.

**Parameters:**

| Parameter | How to specify | Default |
|-----------|---------------|---------|
| **Date range** | Start/end dates, or a month name (e.g., "October 2025") | *(required, ask user)* |
| **CUDA build / variant** | CUDA version like `cuda12_8`, `cuda13_0`, or `cpu`, `xpu`, `rocm6_4` | `cuda12_8` |
| **Size threshold** | Minimum MB delta to flag as "significant" | `1` MB |

**Mapping user input to artifact names:**

| User says | Artifact name | Approx Size |
|-----------|---------------|-------------|
| `cpu` | `manywheel-py3_12-cpu` | ~175 MB |
| `cuda13.0`, `cu130`, `cuda13_0` | `manywheel-py3_12-cuda13_0` | ~585 MB |
| `xpu` | `manywheel-py3_12-xpu` | ~694 MB |
| `cuda12.6`, `cu126`, `cuda12_6` | `manywheel-py3_12-cuda12_6` | ~794 MB |
| `cuda12.8`, `cu128`, `cuda12_8` | `manywheel-py3_12-cuda12_8` | ~860 MB |
| `cuda12.9`, `cu129`, `cuda12_9` | `manywheel-py3_12-cuda12_9` | ~1,197 MB |
| `rocm6.4`, `rocm6_4` | `manywheel-py3_12-rocm6_4` | ~4,214 MB |
| `rocm7.0`, `rocm7_0` | `manywheel-py3_12-rocm7_0` | ~4,342 MB |

The full artifact name pattern is: `manywheel-py3_12-{variant}`

### Step 2: Query workflow runs

The workflow ID for `linux-binary-manywheel` is **21257348** in `pytorch/pytorch`.

For each day in the date range, fetch the workflow run:

```bash
gh api "repos/pytorch/pytorch/actions/workflows/21257348/runs?branch=nightly&created=YYYY-MM-DD&per_page=1"
```

Extract the `id` field from `.workflow_runs[0].id`.

### Step 3: Get artifact sizes

For each workflow run, list its artifacts:

```bash
gh api "repos/pytorch/pytorch/actions/runs/{run_id}/artifacts?per_page=100"
```

Find the artifact matching the requested variant name and extract `size_in_bytes`.

Convert to MB: `size_in_bytes / 1048576`.

### Step 4: Handle missing data

Some days may have:
- **No workflow run**: Note as "no run" in the report
- **Missing artifact**: The build may have failed before producing the artifact, or the artifact name may have temporarily changed (e.g., `cuda12_8` renamed to `cuda12_9` for a few days). Note these in the report.

### Step 5: Produce the report

Generate a report with these sections:

#### Overall summary table
| Metric | Value |
|--------|-------|
| Start size | X MB |
| End size | Y MB |
| Total change | +/- Z MB (N%) |

#### Significant jumps table
List all days where the day-over-day delta exceeds the threshold:
| Date | Size Change | New Size |
|------|------------|----------|
| YYYY-MM-DD | +X.X MB | YYY.Y MB |

#### Daily breakdown table
| Date | Size (MB) | Delta |
|------|-----------|-------|
Full daily data with 1 decimal place precision.

#### Key observations
Summarize patterns (stair-step growth, rollbacks, artifact renames, missing days).

### Step 6: Parallelize for efficiency

When analyzing multiple months, use the Task tool to launch parallel agents - one per month - to collect data concurrently. Each agent should:
1. Query all days in its assigned month
2. Return the complete daily size table
3. Note any anomalies (missing runs, artifact renames)

Then combine the results into a unified report.

## Example usage

**Example 1** — default variant:
```
Analyze wheel sizes for October 2025
```
Uses `manywheel-py3_12-cuda12_8` (the default).

**Example 2** — specifying CUDA version:
```
Analyze wheel sizes for cuda13.0 in October 2025
```
Maps `cuda13.0` to artifact `manywheel-py3_12-cuda13_0`.

**Example 3** — specifying variant and date range:
```
Track cuda12_6 wheel size from Oct 10 to Oct 15, 2025
```

**Example 4** — multiple months:
```
Compare cuda12_8 wheel sizes for October, November, and December 2025
```
Launches parallel agents per month.

**Example 5** — investigating a specific jump:
```
What caused the cuda12_8 wheel size jump on Oct 11, 2025?
```
Compares nightly commit SHAs between Oct 10 and Oct 11 and examines the git log.

## Investigating size jumps

When the user asks what caused a specific size jump, follow this process:

### Step 1: Get the nightly base SHAs

Each nightly release commit message contains the base SHA from the main branch in the format: `"YYYY-MM-DD nightly release (BASE_SHA)"`.

```bash
# Get run for the day before
gh api "repos/pytorch/pytorch/actions/workflows/21257348/runs?branch=nightly&created=YYYY-MM-DD&per_page=1" --jq '.workflow_runs[0].head_sha'
# Get the commit message containing the base SHA
gh api "repos/pytorch/pytorch/commits/{nightly_sha}" --jq '.commit.message'
```

Extract the base SHA from both the day before and the day of the jump.

### Step 2: List commits between the two base SHAs

```bash
gh api "repos/pytorch/pytorch/compare/{base_sha_before}...{base_sha_after}" \
  --jq '[.commits[] | {sha: .sha[0:12], msg: .commit.message | split("\n")[0]}]'
```

### Step 3: Identify likely candidates

Look for these categories of changes that increase binary size:

| Category | Why it increases size | Examples |
|----------|----------------------|----------|
| **Compiler flag changes** | `-O2` → `-O3` enables aggressive inlining, loop unrolling, function cloning | CMake optimization flags, `torch_compile_options` |
| **New CUDA kernel template instantiations** | Each template instantiation compiles for every target SM architecture (~9 for cuda12_8) | New `gpu_reduce_kernel<>` variants, CUTLASS kernels |
| **New CUTLASS/FBGEMM kernel families** | CUTLASS kernels are heavily templated; a single new family can add 1+ MB | Regex changes in `aten/src/ATen/CMakeLists.txt` for FBGEMM |
| **Header-only template library updates** | Template code in headers compiles into every translation unit that includes them | cudnn_frontend submodule bumps |
| **New C++ compilation units** | New `.cpp`/`.cu` files with template-heavy code (type conversions, STL containers) | Stable ABI scaffolding, new shim files |
| **Submodule bumps** | Updated libraries bring new compiled code | FBGEMM, cudnn_frontend, NCCL, nvshmem |
| **New operator implementations** | New ATen native ops add compiled code | New BLAS routines, grouped GEMM |

### Step 4: Discard net-zero commits

Many commits get landed then reverted in the same nightly window. Check for revert pairs and exclude them from analysis.

### Step 5: Verify suspects via build logs

After identifying candidate commits, verify the size impact using actual build logs. Do NOT rely solely on code analysis — always confirm with real data.

**Method A — Per-commit check-runs (preferred when available):**

1. Get the suspect commit's parent:
   ```bash
   gh api "repos/pytorch/pytorch/commits/{suspect_sha}" --jq '.parents[0].sha'
   ```

2. Find manywheel build jobs for both the suspect and parent:
   ```bash
   gh api "repos/pytorch/pytorch/commits/{sha}/check-runs?per_page=100" \
     --jq '[.check_runs[] | select(.name | test("cuda1[23]|manywheel")) | {name: .name, id: .id}]'
   ```
   Paginate if needed (`page=2`, `page=3`).

3. Fetch the S3 build log and search for wheel file size:
   ```
   https://ossci-raw-job-status.s3.amazonaws.com/log/{job_id}
   ```
   Look for patterns: `torch-*.whl`, `size`, `MB`, `bytes`, `ls -la`, artifact upload messages.

4. Compare sizes between the suspect commit and its parent.

Note: Manywheel builds do NOT run for every commit on main. They only run on the nightly branch. If no manywheel job exists for a specific commit, use Method B.

**Method B — Cross-variant nightly comparison:**

Compare sizes across multiple CUDA variants and CPU. If a size jump appears in CUDA builds but NOT in CPU builds, it confirms the increase is in compiled CUDA code (new kernel instantiations, CUTLASS kernels). If it appears in all variants including CPU, it's likely a shared C++ code change or build config change.

```bash
# Check published nightly wheel sizes via HTTP HEAD requests
# Pattern: https://download.pytorch.org/whl/nightly/cu128/torch-2.X.0.devYYYYMMDD%2Bcu128-cp312-cp312-linux_x86_64.whl
```

**Method C — HUD commit page:**

Visit `https://hud.pytorch.org/pytorch/pytorch/commit/{sha}` to see all CI jobs for a commit, then extract the job ID and check its S3 log.

### Verification checklist

When reporting root causes, mark each as:
- **CONFIRMED** — verified via build logs showing size delta on the exact commit
- **LIKELY** — strong code-level evidence but no per-commit build comparison available
- **NOT CONFIRMED** — build logs show negligible or no impact
- **CLEARED** — build logs disprove the hypothesis

## Known historical size changes

Reference data for `manywheel-py3_12-cuda12_8` (x86):

### October 2025 — +11.7 MB (855.3 → 867.0 MB)

| Date | Jump | Root Cause | PR | Status |
|------|------|-----------|-----|--------|
| **Oct 11** | **+4.0 MB** | CMake removed forced `-O2` from `torch_compile_options`, causing fallback to `-O3`. Aggressive inlining/unrolling across all core libraries. Per-commit macOS arm64 build: parent 67.19 MB → commit 68.59 MB (+1.41 MB, +2.09%). Nightly cuda12_8: +4.28 MB. | #164894 | **CONFIRMED** |
| **Oct 18** | **+2.3 MB** | New CUDA template instantiations for sum/mean: removed `#ifdef USE_ROCM` guards, adding `gpu_reduce_kernel<scalar_t, out_t, 4, 8>` for Half/BFloat16 across all SM architectures. Nightly: CUDA 12.8 +2.25 MB, CUDA 12.6 +2.10 MB, CPU +9 KB (zero). CUDA-only impact confirms new kernel instantiations. | #165055 | **CONFIRMED** |
| **Oct 18** | — | cudnn frontend 1.15.0 update. Originally suspected but landed in Oct 19 nightly which *decreased* by 312 KB. | #165776 | **CLEARED** |
| **Oct 29** | **+1.6 MB** | NVFP4 grouped GEMM via FBGEMM: expanded CUTLASS kernel build regex to include `f4f4bf16_grouped` family. Nightly: cuda12_8 +1.65 MB, cuda13_0 +1.41 MB. Consistent across all Python versions. | #166308 | **CONFIRMED** |
| **Oct 30** | **+3.8 MB** | Originally attributed to stable ABI scaffolding (PRs #163683, #164332, #163991, #164356) and NCCL shrink_group (#164518). Build log verification showed stable ABI commits had ~0 KB impact (code reorg + headers), FC/BC policy was docs-only (0 KB), and NCCL shrink_group was ~10-30 KB. **Root cause still unidentified** — may involve Docker image changes or other commits in the window. | — | **NOT CONFIRMED** |

### November 2025 — Net +1.2 MB (867.1 → 868.3 MB)

- **Nov 4-5**: +4.7 MB spike (867.1 → 871.8 MB), then rolled back on Nov 12 (-4.1 MB)
- **Nov 15-17**: Artifact temporarily renamed to `cuda12_9` (~1,211 MB) — CUDA version change, not code growth
- **Nov 25-30**: No workflow runs (Thanksgiving week)

### December 2025 — +1.8 MB (868.3 → 870.1 MB)

- Very stable month. Largest single-day jump: Dec 3 (+0.9 MB). No days >1 MB.

### January 2026 — -90.6 MB (870.2 → 779.6 MB)

- **Jan 6**: -29.7 MB — major dependency or build config removal
- **Jan 17**: -67.1 MB — largest single-day drop, likely significant library removal
- **Jan 25**: +4.9 MB — only notable increase

### February 2026 — -3.0 MB (779.6 → 776.6 MB)

- **Feb 6**: -1.8 MB step down
- **Feb 19**: -1.6 MB step down
- No days with >1 MB increase

### March 2026 (1st-10th) — -3.1 MB (776.6 → 773.5 MB)

- **Mar 5**: -2.6 MB step down
- Stable otherwise. No increases of concern.

## Tips

- The `gh api` command handles pagination and authentication automatically
- Workflow runs are typically created daily around 07:30 UTC for nightly builds
- Artifact sizes from the GitHub API are pre-compression; they reflect the uploaded zip size
- Weekend/holiday periods may have missing runs
- When investigating jumps, launch parallel Task agents — one per problematic day — to analyze commits concurrently
