# Design Doc: Rework Wheel Building Workflows — Remove Conda, Adopt cibuildwheel

**Author:** atalman
**Status:** Draft
**Created:** 2026-02-24

---

## 1. Problem Statement

The current PyTorch ecosystem wheel build infrastructure in `pytorch/test-infra` relies heavily on conda environments for Python isolation, dependency management, and build toolchain setup. This introduces several problems:

1. **Conda overhead and fragility:** Every build creates a dedicated conda environment (`conda_environment_${GITHUB_RUN_ID}`) with cmake, ninja, libwebp, libpng, pkg-config, and wheel. Conda solver failures, channel priority issues, and SSL verification workarounds (especially on aarch64) cause intermittent build failures.

2. **Inconsistent platform behavior:** Linux defaults `setup-miniconda: true`, macOS defaults to `false`, and Windows x64 uses a pre-installed Miniconda at `C:/Jenkins/Miniconda3` while Windows arm64 uses `actions/setup-python` with a venv. This divergence makes maintenance and debugging difficult.

3. **Custom manylinux compliance:** Instead of using standard tooling, we manually rewrite wheel tags via `repair_manylinux_2_28.sh` (sed on WHEEL metadata + SHA256 RECORD regeneration). This is brittle and duplicates functionality already available in `auditwheel`.

4. **High barrier for ecosystem libraries:** Each ecosystem library (torchvision, torchaudio, executorch, etc.) must understand a 20+ parameter reusable workflow interface with platform-specific quirks (`env-script` vs `env-var-script`, `wheel-build-params`, etc.).

5. **Wasted runner time — one runner per Python version:** The current build matrix spins up a separate GHA runner for every (Python version × CUDA variant) combination. For a library building across 7 Python versions and 4 CUDA variants, that is 28 independent runners per platform. Each runner pays the full cost of machine provisioning, repo checkout, conda environment creation, and torch installation — even though the underlying C++ compilation and CUDA environment are identical across Python versions. This is a significant waste of compute resources and billable runner minutes.

---

## 2. Goals

| # | Goal | Priority |
|---|------|----------|
| G1 | Remove conda as a build-time dependency for wheel builds | P0 |
| G2 | Adopt `cibuildwheel` as the standard wheel build orchestrator | P0 |
| G3 | Minimize changes required in ecosystem libraries (torchvision, torchaudio, etc.) | P0 |
| G4 | Maintain support for CUDA, ROCm, XPU, and CPU variants | P0 |
| G5 | Reduce runner costs by building multiple Python versions on a single machine per CUDA variant | P0 |
| G6 | Preserve the existing upload pipeline (S3, R2, PyPI) | P0 |
| G7 | Support free-threaded Python (3.13t, 3.14t) | P0 |
| G8 | Maintain manylinux_2_28 compliance on Linux | P0 |

### Non-Goals

- Changing the PyTorch core (`pytorch/pytorch`) wheel build process (separate effort).
- Changing the S3 index structure or download.pytorch.org layout.

---

## 3. Current Architecture

```
Ecosystem Repo (e.g. pytorch/vision)
  │
  │  calls reusable workflow with ~20 parameters
  ▼
build_wheels_{linux,macos,windows}.yml        ← GHA reusable workflows
  │
  ├─ setup-binary-builds/action.yml           ← GHA composite action
  │    ├─ checkout ecosystem repo
  │    ├─ conda create env (Python, cmake, ninja, libwebp, libpng, pkg-config, wheel)
  │    └─ pytorch_pkg_helpers → BUILD_ENV_FILE (PATH, PIP_INSTALL_TORCH, S3_BUCKET_PATH)
  │
  ├─ source BUILD_ENV_FILE
  ├─ pip install torch (from download.pytorch.org)
  ├─ run pre-script
  ├─ python setup.py bdist_wheel  OR  python -m build --wheel
  ├─ repair_manylinux_2_28.sh (Linux) / delocate-wheel (macOS)
  ├─ run post-script
  ├─ smoke test
  └─ _binary_upload.yml → S3 / R2 / PyPI
```

### Key Pain Points in Current System

| Component | Issue |
|-----------|-------|
| `setup-binary-builds/action.yml` | Creates conda env with 7+ packages; free-threaded Python needs conda-forge; aarch64 needs Miniforge download |
| `build_wheels_linux.yml` | 24 inputs + 4 secrets; conda activation in Docker containers alongside `/opt/python` manylinux paths |
| `build_wheels_windows.yml` | Two completely different code paths for x64 (conda) vs arm64 (venv) |
| `repair_manylinux_2_28.sh` | Manual wheel tag rewriting; duplicates `auditwheel` functionality |
| `pytorch_pkg_helpers` | Generates shell export statements; tightly coupled to conda env |
| Build matrix fan-out | Spins a separate runner for every (Python version × CUDA variant); 6 Python × 4 CUDA = 24 runners per platform, mostly duplicating the same C++/CUDA compilation work |

---

## 4. Proposed Architecture

### 4.1 Overview

Replace the conda-based build environment with `cibuildwheel` (CIBW), which provides:
- Automatic Python version management (no conda needed)
- Built-in manylinux container support with `auditwheel repair`
- Built-in `delocate` on macOS
- Cross-platform consistency (Linux, macOS, Windows)
- `pyproject.toml`-based configuration
- **Build multiple Python versions on a single runner** — dramatically reducing runner costs

```
Ecosystem Repo (e.g. pytorch/vision)
  │
  │  calls reusable workflow with simplified parameters
  ▼
build_wheels_{linux,macos,windows}.yml        ← Simplified GHA reusable workflows
  ├─ checkout ecosystem repo
  ├─ generate BUILD_ENV (pytorch_pkg_helpers v2 — no conda dependency)
  ├─ cibuildwheel --platform {linux,macos,windows}
  │    ├─ CIBW manages Python versions (CPython from python.org, free-threaded included)
  │    ├─ CIBW manages manylinux containers (manylinux_2_28 images)
  │    ├─ CIBW runs before-build hook (install torch, pre-script)
  │    ├─ CIBW builds wheel (setup.py or build module)
  │    ├─ CIBW repairs wheel (auditwheel on Linux, delocate on macOS)
  │    └─ CIBW runs test-command hook (smoke test)
  │
  └─ _binary_upload.yml → S3 / R2 / PyPI  (unchanged)
```

### 4.2 Runner Consolidation — Multiple Python Versions on a Single Machine

A key advantage of cibuildwheel is that it can build wheels for **all requested Python versions sequentially on a single runner**. Today, the build matrix fans out one runner per (Python version × CUDA variant) combination:

**Current approach (one runner per Python version):**
```
                          ┌─ Runner: py3.10 + cu126  (checkout, conda, build, test, upload)
                          ├─ Runner: py3.11 + cu126  (checkout, conda, build, test, upload)
torchvision cu126 build ──├─ Runner: py3.12 + cu126  (checkout, conda, build, test, upload)
                          ├─ Runner: py3.13 + cu126  (checkout, conda, build, test, upload)
                          ├─ Runner: py3.13t + cu126 (checkout, conda, build, test, upload)
                          └─ Runner: py3.14 + cu126  (checkout, conda, build, test, upload)

Total: 6 runners × 4 CUDA variants = 24 runners for Linux x86_64 alone
```

Each runner independently provisions the machine, checks out the repo, creates a conda environment, installs torch, compiles C++/CUDA extensions, and builds the wheel. The C++/CUDA compilation work is largely identical across Python versions — only the Python binding layer differs.

**New approach with cibuildwheel (one runner per CUDA variant):**
```
                          ┌─ Runner: cu126 → cibuildwheel builds py3.10, 3.11, 3.12, 3.13, 3.13t, 3.14
torchvision cu126 build ──│    (single checkout, single machine, CIBW manages Python versions)
                          │    outputs: 6 wheels
```

```
Total: 1 runner × 4 CUDA variants = 4 runners for Linux x86_64
```

cibuildwheel handles this natively via the `CIBW_BUILD` selector. By setting `CIBW_BUILD: "cp310-* cp311-* cp312-* cp313-* cp313t-* cp314-*"` (or simply `"cp3*"`), CIBW iterates through each Python version on the same machine, installing the appropriate CPython interpreter, building the wheel, repairing it, and running smoke tests — all without re-provisioning.

**Impact on the build matrix:**

The `build-matrix` input changes from a matrix over `(python_version, desired_cuda)` to a matrix over just `(desired_cuda)`. Python versions are specified via `CIBW_BUILD` instead.

```yaml
# Before: matrix explodes across Python × CUDA (24 jobs for 6 Python × 4 CUDA)
strategy:
  matrix:
    include:
      - python_version: "3.10"
        desired_cuda: "cu126"
      - python_version: "3.11"
        desired_cuda: "cu126"
      # ... 22 more combinations

# After: matrix only over CUDA variants (4 jobs, CIBW handles Python)
strategy:
  matrix:
    include:
      - desired_cuda: "cu126"
      - desired_cuda: "cu128"
      - desired_cuda: "cu130"
      - desired_cuda: "cpu"
env:
  CIBW_BUILD: "cp310-* cp311-* cp312-* cp313-* cp313t-* cp314-*"
```

**Estimated runner savings:**
- Current: ~24 runners per platform per library (6 Python × 4 CUDA)
- New: ~4 runners per platform per library (1 per CUDA variant)
- **~6x reduction in runner count**, with proportional savings in provisioning overhead, checkout time, and billable minutes

> **Note:** There is a tradeoff between parallelism and cost. Building all Python versions sequentially on one machine increases wall-clock time for that job. For time-sensitive builds (e.g., nightly deadlines), a hybrid approach is possible: split into 2-3 runners per CUDA variant (e.g., one for py3.10-3.12, one for py3.13-3.14t) to balance cost and latency.

### 4.3 cibuildwheel Configuration Strategy

cibuildwheel is configured via environment variables and/or `pyproject.toml`. Since ecosystem libraries already have their own `pyproject.toml`, we provide **shared configuration via environment variables** set by the reusable workflow, while libraries can override via their own `pyproject.toml` `[tool.cibuildwheel]` section.

#### 4.3.1 Shared CIBW Environment Variables (set by reusable workflow)

```yaml
env:
  # Build only the requested Python version (from matrix)
  CIBW_BUILD: "cp${PYTHON_VERSION_NODOT}-*"
  # e.g., CIBW_BUILD: "cp312-*" or "cp313t-*" for free-threaded

  # Platform tags
  CIBW_MANYLINUX_X86_64_IMAGE: "pytorch/manylinux2_28-builder:cuda${CUDA_VERSION}"
  CIBW_MANYLINUX_AARCH64_IMAGE: "pytorch/manylinux2_28-builder:cuda${CUDA_VERSION}-aarch64"

  # Install torch before building the ecosystem library
  CIBW_BEFORE_BUILD: >
    pip install torch${TORCH_VERSION_SPEC} --index-url https://download.pytorch.org/whl/${CHANNEL}/${GPU_ARCH_VERSION}

  # Smoke test
  CIBW_TEST_COMMAND: "python -c 'import ${PACKAGE_NAME}; print(${PACKAGE_NAME}.__version__)'"

  # Repair wheel (Linux uses auditwheel, macOS uses delocate — both built-in to CIBW)
  CIBW_REPAIR_WHEEL_COMMAND_LINUX: "auditwheel repair -w {dest_dir} {wheel} --plat manylinux_2_28_x86_64"
  CIBW_REPAIR_WHEEL_COMMAND_MACOS: "delocate-wheel --require-archs arm64 -w {dest_dir} {wheel}"

  # Build dependencies (replaces conda env packages)
  CIBW_BEFORE_BUILD_LINUX: "yum install -y libpng-devel libwebp-devel && pip install cmake ninja"
  CIBW_BEFORE_BUILD_MACOS: "brew install libpng webp && pip install cmake ninja"

  # Skip architectures we don't build
  CIBW_SKIP: "pp* *-musllinux_*"

  # CUDA environment
  CIBW_ENVIRONMENT: >
    FORCE_CUDA=1
    CUDA_HOME=/usr/local/cuda
    TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST}"
    BUILD_VERSION="${BUILD_VERSION}"
```

#### 4.3.2 Ecosystem Library Override (optional pyproject.toml)

Libraries that need custom behavior can add to their `pyproject.toml`:

```toml
[tool.cibuildwheel]
# Override or extend the before-build to add library-specific deps
before-build = [
    "pip install torch{env:TORCH_VERSION_SPEC} --index-url https://download.pytorch.org/whl/{env:CHANNEL}/{env:GPU_ARCH_VERSION}",
    "bash packaging/pre_build_script.sh"
]

# Custom test command
test-command = "python test/smoke_test.py"

[tool.cibuildwheel.linux]
repair-wheel-command = "auditwheel repair -w {dest_dir} {wheel} --plat manylinux_2_28_{machine}"
```

### 4.4 Custom manylinux Images with CUDA

cibuildwheel supports custom manylinux images. The existing `pytorch/manylinux2_28-builder:cuda*` images already contain:
- CUDA toolkit
- cuDNN
- NCCL
- Build tools (gcc, g++)

These images are compatible with cibuildwheel's manylinux support. The key change is that **Python is no longer baked into the image or provided by conda** — cibuildwheel installs CPython from python.org into the container at build time.

**Migration path for images:**
1. Keep using `pytorch/manylinux2_28-builder` images
2. Set `CIBW_MANYLINUX_*_IMAGE` to point to them
3. cibuildwheel will install the correct Python version inside the container
4. The `/opt/python/cpXYZ` paths are no longer used

### 4.5 Reusable Workflow Interface (Simplified)

The new reusable workflow interface reduces the parameter count and unifies cross-platform behavior.

#### `build_wheels.yml` (unified, replaces three separate workflows)

```yaml
on:
  workflow_call:
    inputs:
      # --- Repository ---
      repository:
        type: string
        required: true
      ref:
        type: string
        default: "nightly"
      submodules:
        type: string
        default: "recursive"

      # --- Build Matrix ---
      build-matrix:
        type: string
        required: true
        description: "JSON matrix with: python_version, desired_cuda, gpu_arch_type, container_image, validation_runner, upload_to_base_bucket, build_name, stable_version"

      # --- Build Configuration ---
      package-name:
        type: string
        required: true
      platform:
        type: string
        required: true
        description: "linux, macos, or windows"
      architecture:
        type: string
        default: "x86_64"

      # --- Hooks (ecosystem library customization) ---
      before-build-script:
        type: string
        default: ""
        description: "Script to run before wheel build (replaces pre-script)"
      after-build-script:
        type: string
        default: ""
        description: "Script to run after wheel build (replaces post-script)"
      smoke-test-script:
        type: string
        default: ""
        description: "Smoke test script path"
      env-var-script:
        type: string
        default: ""
        description: "Script that exports additional env vars"

      # --- Upload ---
      trigger-event:
        type: string
        default: ""
      upload-to-pypi:
        type: string
        default: ""

      # --- Caching ---
      cache-path:
        type: string
        default: ""
      cache-key:
        type: string
        default: ""

      # --- Misc ---
      timeout:
        type: number
        default: 120
      cibw-config-file:
        type: string
        default: ""
        description: "Path to a custom cibuildwheel config (pyproject.toml or cibuildwheel.toml) relative to the repo root"
```

**Changes from current interface:**
- `pre-script` → `before-build-script` (aligns with CIBW naming)
- `post-script` → `after-build-script`
- Removed: `setup-miniconda`, `build-platform`, `build-command`, `env-script`, `wheel-build-params`, `runner-type`, `delocate-wheel`, `run-smoke-test`, `pip-install-torch-extra-args`
- Added: `platform`, `cibw-config-file`
- `build-platform` and `build-command` are now controlled via `pyproject.toml` (`[build-system]` section)

### 4.6 pytorch_pkg_helpers v2 (No Conda Dependency)

Refactor `pytorch_pkg_helpers` to remove any conda-specific logic and output a simple env file:

```python
# v2: No conda references, no /opt/python path manipulation
def get_build_env(
    platform: str,
    gpu_arch_version: str,
    python_version: str,
    pytorch_version: str,
    channel: str,
    upload_to_base_bucket: bool,
) -> dict[str, str]:
    """Return a dict of environment variables for the build."""
    env = {}
    env["BUILD_VERSION"] = compute_build_version(pytorch_version, channel, gpu_arch_version)
    env["TORCH_VERSION_SPEC"] = compute_torch_version_spec(pytorch_version, channel)
    env["CHANNEL"] = channel
    env["GPU_ARCH_VERSION"] = gpu_arch_version
    env["PYTORCH_S3_BUCKET_PATH"] = compute_s3_path(gpu_arch_version, channel, upload_to_base_bucket)

    if gpu_arch_version.startswith("cu"):
        env.update(get_cuda_env(gpu_arch_version))
    elif gpu_arch_version.startswith("rocm"):
        env.update(get_rocm_env(gpu_arch_version))

    return env
```

The returned dict is written to `BUILD_ENV_FILE` as `KEY=VALUE` lines (no `export`), compatible with GitHub Actions (`$GITHUB_ENV`) and other CI systems.

### 4.7 Shared Build Logic (CI-Agnostic)

Extract the core build logic into a standalone script that can be called from GHA workflows or a developer's local machine:

```bash
#!/bin/bash
# tools/scripts/build_ecosystem_wheel.sh
# CI-agnostic wheel build script.

set -euo pipefail

# Required env vars (set by CI or manually):
#   PACKAGE_NAME, PYTHON_VERSION, GPU_ARCH_VERSION, CHANNEL, PYTORCH_VERSION, PLATFORM

# Generate build environment
python -m pytorch_pkg_helpers \
  --platform="${PLATFORM}" \
  --gpu-arch-version="${GPU_ARCH_VERSION}" \
  --python-version="${PYTHON_VERSION}" \
  --pytorch-version="${PYTORCH_VERSION}" \
  --channel="${CHANNEL}" \
  --output-format=env > "${BUILD_ENV_FILE:-build.env}"

source "${BUILD_ENV_FILE:-build.env}"

# Run cibuildwheel
export CIBW_BUILD="cp${PYTHON_VERSION/./}-*"
export CIBW_BEFORE_BUILD="pip install torch${TORCH_VERSION_SPEC} --index-url https://download.pytorch.org/whl/${CHANNEL}/${GPU_ARCH_VERSION}"

if [ -n "${BEFORE_BUILD_SCRIPT:-}" ]; then
  export CIBW_BEFORE_BUILD="${CIBW_BEFORE_BUILD} && bash ${BEFORE_BUILD_SCRIPT}"
fi

if [ -n "${SMOKE_TEST_SCRIPT:-}" ]; then
  export CIBW_TEST_COMMAND="python {project}/${SMOKE_TEST_SCRIPT}"
else
  export CIBW_TEST_COMMAND="python -c 'import ${PACKAGE_NAME}; print(${PACKAGE_NAME}.__version__)'"
fi

cibuildwheel --platform "${PLATFORM}" --output-dir wheelhouse
```

### 4.8 Separating Build (CPU) from Smoke Test (GPU)

#### Current Problem: GPU Waste During Builds

Today, build and smoke test are **tightly coupled in a single job on the same runner**. The `validation_runner` matrix key selects the runner for the entire job — for CUDA variants, this means an expensive GPU instance:

| OS | CUDA Runner | Has GPU? |
|----|-------------|----------|
| Linux x86_64 | `linux.g5.4xlarge.nvidia.gpu` | Yes |
| Linux aarch64 | `linux.arm64.m7g.4xlarge` | Yes |
| Windows x64 | `windows.g4dn.xlarge` | Yes |

The build job runs sequentially: checkout → conda setup → install torch → compile C++/CUDA extensions → build wheel → repair wheel → **smoke test** → upload artifact. The GPU is only needed for the final smoke test step, but the GPU runner is occupied for the entire job duration (often 30-60+ minutes of compilation).

```
Current: Single job on GPU runner
┌──────────────────────────────────────────────────────────────────────┐
│ GPU Runner (linux.g5.4xlarge.nvidia.gpu)                             │
│                                                                      │
│  checkout → conda → build C++/CUDA → repair wheel → smoke test → upload │
│  ├───── GPU idle, wasted ──────────────────────┤  ├─ GPU used ─┤     │
│  │            ~30-60 min                       │  │  ~2-5 min  │     │
└──────────────────────────────────────────────────────────────────────┘
```

#### Proposed: Split into Build Job (CPU) + Test Job (GPU)

With cibuildwheel, we have a natural separation point. CIBW's `CIBW_TEST_COMMAND` runs tests inside the build environment, but we can **disable CIBW's built-in test** and instead run a separate downstream test job on a GPU runner:

```
Proposed: Two jobs, build on CPU, test on GPU
┌────────────────────────────────────────────┐
│ CPU Runner (linux.2xlarge) — cheaper        │
│                                            │
│  checkout → cibuildwheel (build + repair)  │
│  → upload artifact                         │
│            ~30-60 min                      │
└────────────────────────────────────────────┘
                    │
                    ▼ artifact download
┌────────────────────────────────────────────┐
│ GPU Runner (linux.g5.4xlarge.nvidia.gpu)    │
│                                            │
│  download wheel → pip install → smoke test │
│            ~5-10 min                       │
└────────────────────────────────────────────┘
```

This means GPU runners are occupied for minutes instead of hours.

#### Workflow Structure

```yaml
jobs:
  build:
    # Build on a CPU runner — no GPU needed for compilation
    runs-on: ${{ matrix.build_runner }}  # e.g., linux.2xlarge
    container:
      image: ${{ matrix.container_image }}
      # No --gpus flag needed
    steps:
      - # checkout, cibuildwheel build, upload artifact
    env:
      CIBW_TEST_SKIP: "*"  # Skip CIBW's built-in test; we test separately

  smoke-test:
    needs: build
    # Test on a GPU runner — only needed for a few minutes
    runs-on: ${{ matrix.validation_runner }}  # e.g., linux.g5.4xlarge.nvidia.gpu
    container:
      options: "--gpus all"
    steps:
      - uses: actions/download-artifact  # Get the wheel from the build job
      - run: pip install *.whl
      - run: python smoke_test.py

  upload:
    needs: smoke-test
    # Upload only after smoke test passes (preserves current guarantee)
    uses: ./.github/workflows/_binary_upload.yml
```

#### Matrix Changes

The `generate_binary_build_matrix.py` script would produce two runner keys per matrix entry:

```python
# Current: single runner for both build and test
"validation_runner": validation_runner(gpu_arch_type, os),

# New: separate runners
"build_runner": build_runner(os),          # Always CPU (e.g., linux.2xlarge)
"validation_runner": validation_runner(gpu_arch_type, os),  # GPU only when needed
```

#### CPU-only Variants

For CPU, ROCm, and XPU builds, the build and test runners are already CPU-only, so the split adds no benefit. The workflow can detect this and collapse back to a single job:

```yaml
smoke-test:
  # Skip separate test job if build runner already has the right hardware
  if: ${{ matrix.build_runner != matrix.validation_runner }}
```

#### Interaction with Runner Consolidation (Section 4.2)

These two optimizations compound: runner consolidation reduces the number of jobs from ~24 to ~4 per platform, and build/test separation ensures those 4 jobs run on cheaper CPU machines. The GPU is only used for a short smoke test per CUDA variant.

**Combined savings estimate (Linux x86_64, 4 CUDA variants):**

| | Current | With CIBW consolidation | With CIBW + build/test split |
|---|---|---|---|
| GPU runner-jobs | 24 (full build+test) | 4 (full build+test) | 4 (smoke test only, ~5 min each) |
| CPU runner-jobs | 0 | 0 | 4 (full build, all Python versions) |
| GPU time consumed | ~24 × 45 min = 1080 min | ~4 × 45 min = 180 min | ~4 × 5 min = 20 min |

---

## 5. Migration Plan

### Phase 1: Foundation (No Ecosystem Changes)

**What:** Build the new infrastructure alongside the old one. No ecosystem library changes.

| Step | Description | Files Changed |
|------|-------------|---------------|
| 1a | Add `cibuildwheel` to test-infra tooling | `requirements.txt`, new test workflows |
| 1b | Refactor `pytorch_pkg_helpers` to v2 (output dict, remove conda refs) | `tools/pkg-helpers/` |
| 1c | Create `tools/scripts/build_ecosystem_wheel.sh` (CI-agnostic script) | New file |
| 1d | Create new reusable workflow `build_wheels_cibw_linux.yml` | New workflow file |
| 1e | Validate with torchvision nightly (Linux CPU-only) | Test workflow |

### Phase 2: Linux Rollout

**What:** Migrate Linux wheel builds. Ecosystem libraries opt-in by switching their workflow call.

| Step | Description | Ecosystem Change Required |
|------|-------------|--------------------------|
| 2a | `build_wheels_cibw_linux.yml` supports x86_64 + CUDA variants | None |
| 2b | `build_wheels_cibw_linux.yml` supports aarch64 | None |
| 2c | torchvision Linux migrates to new workflow | Change workflow reference in `pytorch/vision` |
| 2d | torchaudio Linux migrates | Change workflow reference in `pytorch/audio` |
| 2e | Other ecosystem libraries migrate | Change workflow reference per library |

**Ecosystem library change required (torchvision example):**
```yaml
# Before (in pytorch/vision/.github/workflows/build_wheels_linux.yml):
jobs:
  build:
    uses: pytorch/test-infra/.github/workflows/build_wheels_linux.yml@main
    with:
      repository: pytorch/vision
      pre-script: packaging/pre_build_script.sh
      post-script: packaging/post_build_script.sh
      smoke-test-script: test/smoke_test.py
      package-name: torchvision
      # ... 15+ more parameters

# After:
jobs:
  build:
    uses: pytorch/test-infra/.github/workflows/build_wheels_cibw_linux.yml@main
    with:
      repository: pytorch/vision
      before-build-script: packaging/pre_build_script.sh
      after-build-script: packaging/post_build_script.sh
      smoke-test-script: test/smoke_test.py
      package-name: torchvision
      platform: linux
      # Fewer parameters, simpler interface
```

Optionally, libraries can add a `[tool.cibuildwheel]` section to their `pyproject.toml` for fine-grained control:
```toml
# pytorch/vision/pyproject.toml (optional addition)
[tool.cibuildwheel.linux]
before-build = "bash packaging/pre_build_script.sh"
```

### Phase 3: macOS and Windows

| Step | Description |
|------|-------------|
| 3a | `build_wheels_cibw_macos.yml` for macOS arm64 |
| 3b | `build_wheels_cibw_windows.yml` for Windows x64 and arm64 |
| 3c | Ecosystem libraries migrate macOS and Windows builds |

### Phase 4: Deprecation

| Step | Description |
|------|-------------|
| 4a | Mark old `build_wheels_{linux,macos,windows}.yml` as deprecated |
| 4b | Remove `setup-binary-builds/action.yml` conda logic |
| 4c | Remove `repair_manylinux_2_28.sh` (replaced by auditwheel via CIBW) |
| 4d | Archive old workflows after all consumers migrate |

---

## 6. Compatibility Matrix

### What Stays the Same (No Changes)

| Component | Reason |
|-----------|--------|
| `_binary_upload.yml` | Upload logic is independent of build method |
| `generate_binary_build_matrix.py` | Matrix generation is independent of build method |
| S3/R2/PyPI upload paths | No change to artifact storage |
| `release_versions.sh` | Version tracking unchanged |
| Nightly trigger workflows | Only trigger, don't build |
| Validation workflows | Validate published wheels, independent of build method |
| `pytorch/manylinux2_28-builder` Docker images | Reused as `CIBW_MANYLINUX_*_IMAGE` |

### What Changes

| Component | Current | New |
|-----------|---------|-----|
| Python isolation | conda env | cibuildwheel (CPython from python.org) |
| Build deps (cmake, ninja) | conda install | `CIBW_BEFORE_BUILD: pip install cmake ninja` |
| manylinux repair (Linux) | `repair_manylinux_2_28.sh` | `auditwheel repair` via CIBW |
| dylib bundling (macOS) | Manual `delocate-wheel` step | `delocate-wheel` via CIBW |
| Build command | Inline in workflow YAML | Controlled by `pyproject.toml` `[build-system]` or CIBW config |
| Free-threaded Python | conda-forge `python-freethreading` | CIBW native support (since v2.17) |
| Workflow parameters | 20-24 per platform | ~15 unified across platforms |
| Runner count per library (Linux) | ~24 (1 per Python × CUDA) | ~4 (1 per CUDA variant; CIBW builds all Python versions on same runner) |

### Ecosystem Library Migration Effort

| Library | Estimated Change |
|---------|-----------------|
| `pytorch/vision` (torchvision) | Update workflow ref + rename `pre-script` → `before-build-script`. Optionally add `[tool.cibuildwheel]` to `pyproject.toml`. |
| `pytorch/audio` (torchaudio) | Same as torchvision. `USE_OPENMP=0` moves to `CIBW_ENVIRONMENT` or `pyproject.toml`. |
| `pytorch/executorch` | Already uses `python-build-package` mode; minimal change. |
| `pytorch/torchtune` | Already uses `python-build-package` mode; minimal change. |
| `pytorch/torchrec` | Update workflow ref. |
| `pytorch/tensorrt` | Update workflow ref. |
| Other libraries | Update workflow ref; test smoke tests. |

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| CUDA builds fail in CIBW due to custom manylinux images | Medium | High | Validate early with existing `pytorch/manylinux2_28-builder` images; CIBW supports custom images natively |
| `auditwheel repair` behaves differently from `repair_manylinux_2_28.sh` | Medium | Medium | Run both side-by-side and diff the output wheels; `auditwheel` is more correct |
| Ecosystem libraries break during migration | Low | High | Run old and new workflows in parallel during migration; feature-flag via workflow ref |
| Free-threaded Python not supported in CIBW version | Low | Medium | CIBW ≥ 2.17 supports free-threaded builds; pin minimum version |
| Build times increase due to CIBW overhead | Low | Low | CIBW adds ~30s overhead for Python install; offset by removing conda solver time |

---

## 8. Open Questions

1. **auditwheel vs manual repair:** The current `repair_manylinux_2_28.sh` only rewrites the platform tag without actually checking or bundling shared libraries. Should we switch to full `auditwheel repair` (which bundles `.so` files) or use `auditwheel repair --no-copy-extra-libs` to preserve current behavior?

2. **Unified vs per-platform workflows:** Should we create one `build_wheels_cibw.yml` with a `platform` input, or keep three separate `build_wheels_cibw_{linux,macos,windows}.yml`? A unified workflow is simpler for callers but may accumulate platform-specific conditionals.

3. **pyproject.toml adoption:** Should we require ecosystem libraries to add `[tool.cibuildwheel]` configuration, or should test-infra provide all configuration via environment variables? The latter minimizes ecosystem changes but limits per-library customization.

4. **Runner consolidation granularity:** Building all Python versions on a single runner per CUDA variant gives ~6x runner reduction but increases per-job wall-clock time. Should we build all Python versions on one runner (maximum cost savings), split into 2-3 groups (balanced), or keep one-per-Python for time-critical builds (e.g., release candidates)?

5. **Build/test split vs CIBW built-in tests:** Should we disable `CIBW_TEST_COMMAND` and run a separate GPU smoke test job, or let CIBW run tests inline (which requires the build runner to have GPU access)? The split saves GPU cost but adds job coordination complexity and artifact handoff latency.

6. **CIBW version pinning:** Should we pin a specific cibuildwheel version in test-infra (for reproducibility) or allow ecosystem libraries to specify their own version?

---

## 9. Alternatives Considered

### A. Keep Conda, Only Refactor Workflows

**Pros:** No new tooling; smaller change.
**Cons:** Doesn't address root cause (conda fragility); still requires maintaining conda env creation across 3 platforms.

**Decision:** Rejected. Conda is the primary source of build fragility.

### B. Replace Conda with venv/pip Only (No cibuildwheel)

**Pros:** Simpler; no new tool dependency.
**Cons:** Must manually handle manylinux containers, Python installation, auditwheel/delocate, and platform-specific quirks — all of which cibuildwheel already handles.

**Decision:** Rejected. Would result in reimplementing cibuildwheel poorly.

### C. Fully Adopt cibuildwheel with Default Images (No Custom CUDA Images)

**Pros:** Simplest cibuildwheel setup; use stock manylinux images.
**Cons:** CUDA toolkit, cuDNN, and NCCL must be installed at build time via `CIBW_BEFORE_BUILD`, adding significant build time (~10-15 min per build).

**Decision:** Rejected. Use custom images (`CIBW_MANYLINUX_*_IMAGE`) to keep CUDA pre-installed.

---

## 10. Success Criteria

| Metric | Target |
|--------|--------|
| Conda usage in wheel builds | Zero (removed from all build paths) |
| Ecosystem library migration effort | ≤ 1 PR per library (workflow ref change + optional pyproject.toml) |
| Build success rate | ≥ current rate (measured over 2-week window) |
| Built wheel binary compatibility | Bit-identical or functionally equivalent to current wheels |
| manylinux compliance | All wheels pass `auditwheel check` |
| Runner count reduction | ~6x fewer runners per platform per library (build all Python versions per CUDA variant on a single machine) |
| Platform coverage | Linux x86_64, Linux aarch64, macOS arm64, Windows x64, Windows arm64 |

---

## 11. References

- [cibuildwheel documentation](https://cibuildwheel.pypa.io/)
- [cibuildwheel custom manylinux images](https://cibuildwheel.pypa.io/en/stable/options/#manylinux-image)
- [cibuildwheel free-threaded Python support](https://cibuildwheel.pypa.io/en/stable/options/#free-threaded-support)
- [PEP 600 — manylinux_2_28](https://peps.python.org/pep-0600/)
- Current workflows: `pytorch/test-infra/.github/workflows/build_wheels_*.yml`
- Current build helper: `pytorch/test-infra/tools/pkg-helpers/`
- Matrix generator: `pytorch/test-infra/tools/scripts/generate_binary_build_matrix.py`
