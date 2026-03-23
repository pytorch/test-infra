# Pre-built Clang + libomp for PyTorch CI

This directory contains the build infrastructure for producing pre-built
Clang toolchains (clang, clang-devel, clang-libs) and libomp-devel packages
used by PyTorch CI to compile PyTorch.

## Available builds

| Clang version | Platform | Artifact name |
|---|---|---|
| 15 | linux-x86_64 | `clang-15-linux-x86_64.tar.gz` |
| 15 | linux-aarch64 | `clang-15-linux-aarch64.tar.gz` |
| 18 | linux-x86_64 | `clang-18-linux-x86_64.tar.gz` |
| 18 | linux-aarch64 | `clang-18-linux-aarch64.tar.gz` |

Each tarball contains a complete Clang installation (bin/, lib/, include/, etc.)
built from the corresponding LLVM release sources with OpenMP (libomp) support.

## How CI jobs can download and install

### Option 1: Download from S3 (recommended for CI)

Artifacts are uploaded to the `gha-artifacts` S3 bucket. To download and
install in a CI job:

```yaml
steps:
  - name: Install Clang 18
    run: |
      CLANG_VERSION=18
      PLATFORM=linux-x86_64  # or linux-aarch64
      ARTIFACT="clang-${CLANG_VERSION}-${PLATFORM}"

      # Download from S3
      aws s3 cp \
        "s3://gha-artifacts/clang/${PLATFORM}/clang-${CLANG_VERSION}/${ARTIFACT}.tar.gz" \
        /tmp/${ARTIFACT}.tar.gz

      # Install to /opt/clang
      sudo mkdir -p /opt/clang
      sudo tar xzf /tmp/${ARTIFACT}.tar.gz -C /opt/clang

      # Add to PATH and set environment variables
      echo "/opt/clang/bin" >> "$GITHUB_PATH"
      echo "CC=/opt/clang/bin/clang" >> "$GITHUB_ENV"
      echo "CXX=/opt/clang/bin/clang++" >> "$GITHUB_ENV"
      echo "CMAKE_PREFIX_PATH=/opt/clang" >> "$GITHUB_ENV"

      # Verify
      clang --version
```

### Option 2: Download from GitHub Actions artifacts

For PR builds or when S3 is not accessible, use the GitHub Actions artifact:

```yaml
steps:
  - name: Download Clang artifact
    uses: actions/download-artifact@v4
    with:
      name: clang-18-linux-x86_64
      path: /tmp/clang-artifact

  - name: Install Clang
    run: |
      sudo mkdir -p /opt/clang
      sudo tar xzf /tmp/clang-artifact/clang-18-linux-x86_64.tar.gz -C /opt/clang
      echo "/opt/clang/bin" >> "$GITHUB_PATH"
      echo "CC=/opt/clang/bin/clang" >> "$GITHUB_ENV"
      echo "CXX=/opt/clang/bin/clang++" >> "$GITHUB_ENV"
```

### Option 3: Download from S3 in a shell script

For non-GitHub Actions environments or Docker builds:

```bash
#!/usr/bin/env bash
set -euxo pipefail

CLANG_VERSION="${1:-18}"
PLATFORM="${2:-linux-x86_64}"
INSTALL_DIR="${3:-/opt/clang}"

ARTIFACT="clang-${CLANG_VERSION}-${PLATFORM}"

# Download (use curl if aws cli is not available)
curl -fsSL \
  "https://gha-artifacts.s3.amazonaws.com/clang/${PLATFORM}/clang-${CLANG_VERSION}/${ARTIFACT}.tar.gz" \
  -o /tmp/${ARTIFACT}.tar.gz

# Install
mkdir -p "${INSTALL_DIR}"
tar xzf /tmp/${ARTIFACT}.tar.gz -C "${INSTALL_DIR}"

# Set up environment
export PATH="${INSTALL_DIR}/bin:${PATH}"
export CC="${INSTALL_DIR}/bin/clang"
export CXX="${INSTALL_DIR}/bin/clang++"
export CMAKE_PREFIX_PATH="${INSTALL_DIR}"

# For libomp: the headers are in include/ and the library is in lib/
# CMake will find them automatically via CMAKE_PREFIX_PATH
# For manual linking:
export OpenMP_C_FLAGS="-fopenmp"
export OpenMP_CXX_FLAGS="-fopenmp"
export OpenMP_C_LIB_NAMES="omp"
export OpenMP_CXX_LIB_NAMES="omp"
export OpenMP_omp_LIBRARY="${INSTALL_DIR}/lib/libomp.so"

echo "Clang ${CLANG_VERSION} installed to ${INSTALL_DIR}"
clang --version
```

## What's included in each tarball

```
/opt/clang/
  bin/
    clang             # C compiler
    clang++           # C++ compiler
    clang-<major>     # Versioned symlink
    clang-cpp         # Clang preprocessor
    ...
  lib/
    libclang.so*      # Clang libraries (clang-libs)
    libclang*.a       # Static clang libraries
    libomp.so*        # OpenMP runtime library (libomp-devel)
    clang/            # Clang resource directory (clang-devel)
      <version>/
        include/      # Clang built-in headers
        lib/          # Compiler-rt libraries
  include/
    clang/            # Clang C API headers (clang-devel)
    clang-c/          # Clang C API headers
    omp.h             # OpenMP header (libomp-devel)
    ...
  lib/cmake/          # CMake config files for find_package()
```

## Building PyTorch with the pre-built Clang

After installing Clang from the tarball:

```bash
export PATH=/opt/clang/bin:$PATH
export CC=clang
export CXX=clang++

# CMake will automatically find libomp via the clang resource directory
python setup.py develop
# or
cmake -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ ...
```

## Building locally

To build clang locally (for testing):

```bash
./tools/clang-build/build.sh 18.1.8 /opt/clang-18 "X86;AArch64"
```

## Workflow

The GitHub Actions workflow (`.github/workflows/build-clang.yml`) triggers on:
- Pull requests that modify the workflow or build scripts (build only, no S3 upload)
- Manual workflow dispatch (builds and uploads to S3)

S3 uploads require OIDC authentication via the `gha_workflow_build_clang` IAM role.
