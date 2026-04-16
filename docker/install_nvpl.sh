#!/bin/bash
# Install NVIDIA Performance Libraries (NVPL) for aarch64 CUDA builds.
# Adapted from PyTorch CI: .ci/docker/common/install_nvpl.sh

set -ex

NVPL_BLAS_VERSION="${NVPL_BLAS_VERSION:-0.3.0}"
NVPL_LAPACK_VERSION="${NVPL_LAPACK_VERSION:-0.2.3.1}"

mkdir -p /opt/nvpl/lib /opt/nvpl/include

cd /tmp

wget -q "https://developer.download.nvidia.com/compute/nvpl/redist/nvpl_blas/linux-sbsa/nvpl_blas-linux-sbsa-${NVPL_BLAS_VERSION}-archive.tar.xz"
tar xf "nvpl_blas-linux-sbsa-${NVPL_BLAS_VERSION}-archive.tar.xz"
cp -r "nvpl_blas-linux-sbsa-${NVPL_BLAS_VERSION}-archive/lib/"* /opt/nvpl/lib/
cp -r "nvpl_blas-linux-sbsa-${NVPL_BLAS_VERSION}-archive/include/"* /opt/nvpl/include/
rm -rf "nvpl_blas-linux-sbsa-${NVPL_BLAS_VERSION}-archive" "nvpl_blas-linux-sbsa-${NVPL_BLAS_VERSION}-archive.tar.xz"

wget -q "https://developer.download.nvidia.com/compute/nvpl/redist/nvpl_lapack/linux-sbsa/nvpl_lapack-linux-sbsa-${NVPL_LAPACK_VERSION}-archive.tar.xz"
tar xf "nvpl_lapack-linux-sbsa-${NVPL_LAPACK_VERSION}-archive.tar.xz"
cp -r "nvpl_lapack-linux-sbsa-${NVPL_LAPACK_VERSION}-archive/lib/"* /opt/nvpl/lib/
cp -r "nvpl_lapack-linux-sbsa-${NVPL_LAPACK_VERSION}-archive/include/"* /opt/nvpl/include/
rm -rf "nvpl_lapack-linux-sbsa-${NVPL_LAPACK_VERSION}-archive" "nvpl_lapack-linux-sbsa-${NVPL_LAPACK_VERSION}-archive.tar.xz"
