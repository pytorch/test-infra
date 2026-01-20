#!/usr/bin/env bash
#
# Script to promote PyTorch wheels to variant test channel.
# This script orchestrates the transformation of standard PyTorch wheels
# into wheel variants using variant-repack.
#
# Usage:
#   ./promote_whl_variant_to_test.sh [--dry-run] [--package PACKAGE] [--version VERSION] [--arch ARCH]
#
# Environment variables:
#   DRY_RUN         - Set to "disabled" to actually upload (default: enabled)
#   PYTORCH_VERSION - PyTorch version to promote
#   PYTORCH_RELEASE - PyTorch release series (e.g., 2.10)
#   VARIANT_REPACK_DIR - Path to variant-repack checkout

set -eou pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
source "${DIR}/../release_versions.sh"

# Dry run by default
DRY_RUN=${DRY_RUN:-enabled}

# Default PyTorch release series (derived from PYTORCH_VERSION)
PYTORCH_RELEASE=${PYTORCH_RELEASE:-2.10}

# Variant-repack directory (should be set by CI or caller)
VARIANT_REPACK_DIR=${VARIANT_REPACK_DIR:-./variant-repack}

# Helper function to call upload_variant_to_staging.sh
upload_variant() {
    local package_name=$1
    local package_version=$2
    local platform=$3
    local version_suffix=$4
    local arch=$5

    echo ""
    echo "================================================================"
    echo "Promoting ${package_name} v${package_version} (${arch}) for ${platform}"
    echo "================================================================"
    echo ""

    (
        set -x
        PACKAGE_NAME="${package_name}" \
        PACKAGE_VERSION="${package_version}" \
        PLATFORM="${platform}" \
        VERSION_SUFFIX="${version_suffix}" \
        ARCH="${arch}" \
        PYTORCH_RELEASE="${PYTORCH_RELEASE}" \
        VARIANT_REPACK_DIR="${VARIANT_REPACK_DIR}" \
        DRY_RUN="${DRY_RUN}" \
        bash "${DIR}/upload_variant_to_staging.sh"
    )
}

# URL-encoded version suffixes
CPU_VERSION_SUFFIX="%2Bcpu"
CU126_VERSION_SUFFIX="%2Bcu126"
CU128_VERSION_SUFFIX="%2Bcu128"
CU130_VERSION_SUFFIX="%2Bcu130"
XPU_VERSION_SUFFIX="%2Bxpu"
ROCM70_VERSION_SUFFIX="%2Brocm7.0"
ROCM71_VERSION_SUFFIX="%2Brocm7.1"

echo "========================================"
echo "PyTorch Wheel Variant Promotion"
echo "========================================"
echo "PyTorch Version:  ${PYTORCH_VERSION}"
echo "PyTorch Release:  ${PYTORCH_RELEASE}"
echo "Variant Repack:   ${VARIANT_REPACK_DIR}"
echo "Dry Run:          ${DRY_RUN}"
echo "========================================"

# ============================================================================
# TORCH - Linux x86_64
# ============================================================================
# CPU
upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_x86_64" "${CPU_VERSION_SUFFIX}" "cpu"

# CUDA
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_x86_64" "${CU126_VERSION_SUFFIX}" "cu126"
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_x86_64" "${CU128_VERSION_SUFFIX}" "cu128"
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_x86_64" "${CU130_VERSION_SUFFIX}" "cu130"

# XPU (uses linux_x86_64 platform tag)
# upload_variant "torch" "${PYTORCH_VERSION}" "linux_x86_64" "${XPU_VERSION_SUFFIX}" "xpu"

# ROCm
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_x86_64" "${ROCM70_VERSION_SUFFIX}" "rocm7.0"
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_x86_64" "${ROCM71_VERSION_SUFFIX}" "rocm7.1"

# ============================================================================
# TORCH - Linux aarch64
# ============================================================================
# CPU
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_aarch64" "${CPU_VERSION_SUFFIX}" "cpu"

# CUDA
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_aarch64" "${CU126_VERSION_SUFFIX}" "cu126"
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_aarch64" "${CU128_VERSION_SUFFIX}" "cu128"
# upload_variant "torch" "${PYTORCH_VERSION}" "manylinux_2_28_aarch64" "${CU130_VERSION_SUFFIX}" "cu130"

# ============================================================================
# TORCH - Windows
# ============================================================================
# CPU
# upload_variant "torch" "${PYTORCH_VERSION}" "win_amd64" "${CPU_VERSION_SUFFIX}" "cpu"

# CUDA
# upload_variant "torch" "${PYTORCH_VERSION}" "win_amd64" "${CU126_VERSION_SUFFIX}" "cu126"
# upload_variant "torch" "${PYTORCH_VERSION}" "win_amd64" "${CU128_VERSION_SUFFIX}" "cu128"
# upload_variant "torch" "${PYTORCH_VERSION}" "win_amd64" "${CU130_VERSION_SUFFIX}" "cu130"

# XPU
# upload_variant "torch" "${PYTORCH_VERSION}" "win_amd64" "${XPU_VERSION_SUFFIX}" "xpu"

# ============================================================================
# TORCH - macOS
# ============================================================================
# macOS ARM64 (no suffix)
# upload_variant "torch" "${PYTORCH_VERSION}" "macosx_.*_arm64" "" "cpu"

# ============================================================================
# TORCHVISION - Linux x86_64
# ============================================================================
# CPU
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_x86_64" "${CPU_VERSION_SUFFIX}" "cpu"

# CUDA
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_x86_64" "${CU126_VERSION_SUFFIX}" "cu126"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_x86_64" "${CU128_VERSION_SUFFIX}" "cu128"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_x86_64" "${CU130_VERSION_SUFFIX}" "cu130"

# ROCm
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_x86_64" "${ROCM70_VERSION_SUFFIX}" "rocm7.0"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_x86_64" "${ROCM71_VERSION_SUFFIX}" "rocm7.1"

# XPU
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_x86_64" "${XPU_VERSION_SUFFIX}" "xpu"

# ============================================================================
# TORCHVISION - Linux aarch64
# ============================================================================
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_aarch64" "" "cpu"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_aarch64" "" "cu126"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_aarch64" "" "cu128"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "manylinux_2_28_aarch64" "" "cu130"

# ============================================================================
# TORCHVISION - Windows
# ============================================================================
# CPU
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "win_amd64" "${CPU_VERSION_SUFFIX}" "cpu"

# CUDA
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "win_amd64" "${CU126_VERSION_SUFFIX}" "cu126"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "win_amd64" "${CU128_VERSION_SUFFIX}" "cu128"
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "win_amd64" "${CU130_VERSION_SUFFIX}" "cu130"

# XPU
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "win_amd64" "${XPU_VERSION_SUFFIX}" "xpu"

# ============================================================================
# TORCHVISION - macOS
# ============================================================================
# upload_variant "torchvision" "${TORCHVISION_VERSION}" "macosx_.*_arm64" "" "cpu"


echo ""
echo "========================================"
echo "Wheel variant promotion completed!"
echo "========================================"
