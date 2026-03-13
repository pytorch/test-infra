# PyTorch CI Docker Base Image

Docker base image for PyTorch CI, built on `manylinux_2_34` (AlmaLinux 9). Supports CPU-only and CUDA variants for both x86_64 and aarch64.

## What's included

- **Base**: `quay.io/pypa/manylinux_2_34_{x86_64,aarch64}` (with manylinux Python toolchains)
- **System packages**: autoconf, automake, clang, gcc/g++, git, make, and other build essentials (via dnf)
- **CUDA stack** (when `INSTALL_CUDA=1`): All three CUDA toolkit versions (12.8, 12.9, 13.0), each with cuDNN, NCCL (built from source), nvSHMEM, and cuSPARSELt
- **uv**: Python package manager
- **sccache**: Compiler cache (prebuilt v0.13.0 from GitHub releases)

## CUDA layout

CUDA images contain all three versions installed side-by-side:

```
/usr/local/cu128/        # CUDA 12.8 toolkit + cuDNN + nvSHMEM + NCCL + cuSPARSELt
/usr/local/cu129/        # CUDA 12.9
/usr/local/cu130/        # CUDA 13.0
/usr/local/cuda -> /usr/local/cu130   # default symlink
```

| CUDA | Toolkit | cuDNN     | NCCL      | cuSPARSELt |
| ---- | ------- | --------- | --------- | ---------- |
| 12.8 | 12.8.1  | 9.19.0.56 | v2.28.9-1 | 0.7.1      |
| 12.9 | 12.9.1  | 9.17.1.4  | v2.28.9-1 | 0.7.1      |
| 13.0 | 13.0.2  | 9.19.0.56 | v2.28.9-1 | 0.8.0      |

## Build locally

Requires Docker with BuildKit support (`docker buildx` or `DOCKER_BUILDKIT=1`).

```bash
# CPU-only
docker build -t ciforge:cpu docker/

# CUDA (all versions)
docker build --build-arg INSTALL_CUDA=1 -t ciforge:cuda docker/

# aarch64 (on an aarch64 host, or with --platform)
docker build --build-arg BASE_IMAGE=quay.io/pypa/manylinux_2_34_aarch64 \
             --build-arg INSTALL_CUDA=1 \
             -t ciforge:cuda-aarch64 docker/
```

### Override NCCL / nvSHMEM versions

```bash
docker build --build-arg INSTALL_CUDA=1 \
             --build-arg NCCL_VERSION=v2.26.5-1 \
             --build-arg NVSHMEM_VERSION=3.3.9 \
             -t ciforge:cuda-custom docker/
```

## Verify a build

```bash
docker run --rm ciforge:cpu bash -c "gcc --version && clang --version && git --version && uv --version && sccache --version"
```

For CUDA builds:

```bash
# Verify all three toolkits are present
docker run --rm ciforge:cuda ls /usr/local/cu128/bin/nvcc /usr/local/cu129/bin/nvcc /usr/local/cu130/bin/nvcc

# Verify default symlink
docker run --rm ciforge:cuda readlink /usr/local/cuda   # /usr/local/cu130

# Verify default nvcc
docker run --rm ciforge:cuda nvcc --version   # CUDA 13.0

# Verify NCCL in each prefix
docker run --rm ciforge:cuda ls /usr/local/cu128/include/nccl.h /usr/local/cu129/include/nccl.h /usr/local/cu130/include/nccl.h
```

## CI workflow

Images are built and published to `ghcr.io/pytorch/ciforge` by the GitHub Actions workflow in `.github/workflows/docker-build.yml`.

- **PRs**: build-only validation (no push, read-only permissions)
- **Push to main**: build then publish to GHCR
- **Schedule**: daily rebuild at 06:00 UTC
- **Manual**: `workflow_dispatch`

### Image tags

Each variant is tagged with the short commit SHA and a `latest` alias:

```
ghcr.io/pytorch/ciforge:cpu-x86_64-<sha>
ghcr.io/pytorch/ciforge:cpu-x86_64-latest
ghcr.io/pytorch/ciforge:cuda-x86_64-<sha>
ghcr.io/pytorch/ciforge:cuda-aarch64-latest
...
```

## Files

| File               | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `Dockerfile`       | Main image definition                                        |
| `install_cuda.sh`  | CUDA toolkit + cuDNN + NCCL + nvSHMEM + cuSPARSELt installer |
| `install_cache.sh` | sccache installer (prebuilt binary)                          |
| `.dockerignore`    | Build context exclusions                                     |
