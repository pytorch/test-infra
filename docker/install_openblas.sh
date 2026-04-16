#!/bin/bash
# Install OpenBLAS for aarch64 CPU builds.
# Adapted from PyTorch CI: .ci/docker/common/install_openblas.sh

set -ex

OPENBLAS_VERSION="${OPENBLAS_VERSION:-v0.3.30}"

git clone https://github.com/OpenMathLib/OpenBLAS.git \
    -b "${OPENBLAS_VERSION}" --depth 1 --shallow-submodules

OPENBLAS_BUILD_FLAGS="
CC=gcc
NUM_THREADS=128
USE_OPENMP=1
NO_SHARED=0
DYNAMIC_ARCH=1
TARGET=ARMV8
CFLAGS=-O3
BUILD_BFLOAT16=1
"

make -j"$(nproc)" ${OPENBLAS_BUILD_FLAGS} -C OpenBLAS
make install -C OpenBLAS

rm -rf OpenBLAS
