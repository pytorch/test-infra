#!/bin/bash
# Install ARM Compute Library (ACL) for aarch64 builds.
# Adapted from PyTorch CI: .ci/docker/common/install_acl.sh

set -eux

ACL_VERSION="${ACL_VERSION:-v52.6.0}"
ACL_INSTALL_DIR="/acl"

git clone https://github.com/ARM-software/ComputeLibrary.git \
    -b "${ACL_VERSION}" --depth 1 --shallow-submodules

pushd ComputeLibrary
scons -j"$(nproc)" Werror=0 debug=0 neon=1 opencl=0 embed_kernels=0 \
    os=linux arch=armv8a build=native multi_isa=1 \
    fixed_format_kernels=1 openmp=1 cppthreads=0
popd

mkdir -p "${ACL_INSTALL_DIR}"
for d in arm_compute include utils support src build; do
    cp -r "ComputeLibrary/${d}" "${ACL_INSTALL_DIR}/${d}"
done

rm -rf ComputeLibrary
