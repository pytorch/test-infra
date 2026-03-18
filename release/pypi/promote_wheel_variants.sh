#!/usr/bin/env bash
#
# Script to promote PyTorch wheel variants to the test/staging bucket.
#
# This script downloads wheels from the PyTorch test channel, transforms them
# using variant-repack to create wheel variants, and uploads to S3.
#
# Usage:
#   ./promote_wheel_variants.sh --package torch --version 2.10.0
#   ./promote_wheel_variants.sh --package torchvision --version 0.23.0
#   ./promote_wheel_variants.sh --package torchaudio --version 2.10.0
#
# Environment variables:
#   DRY_RUN            - Set to "disabled" to actually upload (default: enabled)
#   PYTORCH_RELEASE    - PyTorch release series for configs (default: 2.10)
#   VARIANT_REPACK_DIR - Path to variant-repack checkout (default: ./variant-repack)
#   OUTPUT_BUCKET      - S3 bucket path for output (default: s3://pytorch/whl/test/variant/)

set -eou pipefail

# Parse command line arguments
PACKAGE_NAME=""
PACKAGE_VERSION=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --package)
            PACKAGE_NAME="$2"
            shift 2
            ;;
        --version)
            PACKAGE_VERSION="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 --package <torch|torchvision|torchaudio> --version <version>"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate required arguments
if [[ -z "${PACKAGE_NAME}" ]]; then
    echo "ERROR: --package is required"
    exit 1
fi

if [[ -z "${PACKAGE_VERSION}" ]]; then
    echo "ERROR: --version is required"
    exit 1
fi

# Configuration
PYTORCH_RELEASE=${PYTORCH_RELEASE:-2.10}
VARIANT_REPACK_DIR=${VARIANT_REPACK_DIR:-./variant-repack}
OUTPUT_BUCKET=${OUTPUT_BUCKET:-s3://pytorch/whl/test/variant/}
DRY_RUN=${DRY_RUN:-enabled}

# Validate variant-repack installation
if ! command -v variant_repack &> /dev/null; then
    echo "ERROR: variant_repack command not found. Please install variant-repack first."
    echo "  pip install -e ${VARIANT_REPACK_DIR}"
    exit 1
fi

# Validate config files exist
PYPROJECT_TOML="${VARIANT_REPACK_DIR}/configs/torch-${PYTORCH_RELEASE}/torch_pyproject.toml"
VARIANT_CONFIG_TOML="${VARIANT_REPACK_DIR}/configs/torch-${PYTORCH_RELEASE}/torch_variant_config.toml"

if [[ ! -f "${PYPROJECT_TOML}" ]]; then
    echo "ERROR: PyProject config not found: ${PYPROJECT_TOML}"
    exit 1
fi

if [[ ! -f "${VARIANT_CONFIG_TOML}" ]]; then
    echo "ERROR: Variant config not found: ${VARIANT_CONFIG_TOML}"
    exit 1
fi

# Dry run flag for aws commands
DRY_RUN_FLAG="--dryrun"
if [[ "${DRY_RUN}" == "disabled" ]]; then
    DRY_RUN_FLAG=""
fi

echo "========================================"
echo "PyTorch Wheel Variant Promotion"
echo "========================================"
echo "Package:         ${PACKAGE_NAME}"
echo "Version:         ${PACKAGE_VERSION}"
echo "PyTorch Release: ${PYTORCH_RELEASE}"
echo "Output Bucket:   ${OUTPUT_BUCKET}"
echo "Dry Run:         ${DRY_RUN}"
echo "========================================"

# Define variant configurations per package
# Format: "arch|platform|version_suffix"
declare -a TORCH_VARIANTS=(
    # Linux x86_64
    "cpu|manylinux_2_28_x86_64|%2Bcpu"
    "cu126|manylinux_2_28_x86_64|%2Bcu126"
    "cu128|manylinux_2_28_x86_64|%2Bcu128"
    "cu130|manylinux_2_28_x86_64|%2Bcu130"
    "xpu|linux_x86_64|%2Bxpu"
    "rocm7.0|manylinux_2_28_x86_64|%2Brocm7.0"
    "rocm7.1|manylinux_2_28_x86_64|%2Brocm7.1"
    # Linux aarch64
    "cpu|manylinux_2_28_aarch64|%2Bcpu"
    "cu126|manylinux_2_28_aarch64|%2Bcu126"
    "cu128|manylinux_2_28_aarch64|%2Bcu128"
    "cu130|manylinux_2_28_aarch64|%2Bcu130"
    # Windows
    "cpu|win_amd64|%2Bcpu"
    "cu126|win_amd64|%2Bcu126"
    "cu128|win_amd64|%2Bcu128"
    "cu130|win_amd64|%2Bcu130"
    "xpu|win_amd64|%2Bxpu"
    # macOS (no suffix for CPU-only)
    "cpu|macosx_.*_arm64|"
)

declare -a TORCHVISION_VARIANTS=(
    # Linux x86_64
    "cpu|manylinux_2_28_x86_64|%2Bcpu"
    "cu126|manylinux_2_28_x86_64|%2Bcu126"
    "cu128|manylinux_2_28_x86_64|%2Bcu128"
    "cu130|manylinux_2_28_x86_64|%2Bcu130"
    "xpu|manylinux_2_28_x86_64|%2Bxpu"
    "rocm7.0|manylinux_2_28_x86_64|%2Brocm7.0"
    "rocm7.1|manylinux_2_28_x86_64|%2Brocm7.1"
    # Linux aarch64
    "cpu|manylinux_2_28_aarch64|"
    "cu126|manylinux_2_28_aarch64|"
    "cu128|manylinux_2_28_aarch64|"
    "cu130|manylinux_2_28_aarch64|"
    # Windows
    "cpu|win_amd64|%2Bcpu"
    "cu126|win_amd64|%2Bcu126"
    "cu128|win_amd64|%2Bcu128"
    "cu130|win_amd64|%2Bcu130"
    "xpu|win_amd64|%2Bxpu"
    # macOS
    "cpu|macosx_.*_arm64|"
)

declare -a TORCHAUDIO_VARIANTS=(
    # Linux x86_64
    "cpu|manylinux_2_28_x86_64|%2Bcpu"
    "cu126|manylinux_2_28_x86_64|%2Bcu126"
    "cu128|manylinux_2_28_x86_64|%2Bcu128"
    "cu130|manylinux_2_28_x86_64|%2Bcu130"
    # Linux aarch64
    "cpu|manylinux_2_28_aarch64|%2Bcpu"
    # Windows
    "cpu|win_amd64|%2Bcpu"
    "cu126|win_amd64|%2Bcu126"
    "cu128|win_amd64|%2Bcu128"
    "cu130|win_amd64|%2Bcu130"
    # macOS
    "cpu|macosx_.*_arm64|"
)

# Select variants based on package
case "${PACKAGE_NAME}" in
    torch)
        VARIANTS=("${TORCH_VARIANTS[@]}")
        ;;
    torchvision)
        VARIANTS=("${TORCHVISION_VARIANTS[@]}")
        ;;
    torchaudio)
        VARIANTS=("${TORCHAUDIO_VARIANTS[@]}")
        ;;
    *)
        echo "ERROR: Unknown package: ${PACKAGE_NAME}"
        echo "Supported packages: torch, torchvision, torchaudio"
        exit 1
        ;;
esac

# Create temporary directories
tmp_dir="$(mktemp -d)"
output_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}" "${output_dir}"' EXIT

# Process each variant
success_count=0
skip_count=0
fail_count=0

for variant in "${VARIANTS[@]}"; do
    IFS='|' read -r ARCH PLATFORM VERSION_SUFFIX <<< "${variant}"

    # Remove dots from ARCH to get variant config name (e.g., rocm7.0 -> rocm70)
    VARIANT_CONFIG="${ARCH//./}"

    echo ""
    echo "================================================================"
    echo "Processing: ${PACKAGE_NAME} ${PACKAGE_VERSION} | ${ARCH} | ${PLATFORM}"
    echo "================================================================"

    # Retrieve packages from test index
    echo "Retrieving packages from test index..."
    pkgs_to_promote=$(\
        curl -fsSL "https://download.pytorch.org/whl/test/${ARCH}/${PACKAGE_NAME}/index.html" 2>/dev/null \
            | grep "${PACKAGE_NAME}-${PACKAGE_VERSION}${VERSION_SUFFIX}-" \
            | grep "${PLATFORM}" \
            | cut -d '"' -f2 \
            | cut -d "#" -f1
    ) || true

    if [[ -z "${pkgs_to_promote}" ]]; then
        echo "SKIP: No packages found for ${ARCH}/${PLATFORM}"
        ((skip_count++))
        continue
    fi

    echo "Found packages:"
    echo "${pkgs_to_promote}"

    for pkg in ${pkgs_to_promote}; do
        pkg_basename="$(basename "${pkg}")"
        # Decode URL-encoded characters (e.g., %2B -> +)
        decoded_fname=$(echo "${pkg_basename}" | sed "s/%2B/+/g")
        orig_pkg="${tmp_dir}/${decoded_fname}"

        echo ""
        echo "Processing: ${decoded_fname}"

        # Download the wheel
        echo "  Downloading..."
        if ! curl -fSL -o "${orig_pkg}" "https://download.pytorch.org${pkg}" 2>/dev/null; then
            echo "  FAIL: Download failed"
            ((fail_count++))
            continue
        fi

        # Unpack and repack wheel to ensure consistent format
        echo "  Repacking..."
        pushd "${tmp_dir}" > /dev/null
        mkdir -p unpacked
        if ! unzip -q "${orig_pkg}" -d unpacked 2>/dev/null; then
            echo "  FAIL: Unzip failed"
            rm -rf unpacked "${orig_pkg}"
            popd > /dev/null
            ((fail_count++))
            continue
        fi
        rm "${orig_pkg}"
        wheel pack unpacked -d "${tmp_dir}" > /dev/null 2>&1
        rm -rf unpacked
        popd > /dev/null

        # Find the repacked wheel
        repacked_whl=$(find "${tmp_dir}" -name "*.whl" -type f | head -1)
        if [[ -z "${repacked_whl}" ]]; then
            echo "  FAIL: Repacking failed"
            ((fail_count++))
            continue
        fi

        # Transform using variant-repack
        echo "  Transforming with variant-repack..."
        if ! variant_repack build \
            -i "${repacked_whl}" \
            -o "${output_dir}" \
            --pyproject-toml "${PYPROJECT_TOML}" \
            --variant-config-toml "${VARIANT_CONFIG_TOML}" \
            --variant-config-name "${VARIANT_CONFIG}" \
            --metadata-config-name "${PACKAGE_NAME}" 2>/dev/null; then
            echo "  FAIL: variant-repack transformation failed"
            rm -f "${repacked_whl}"
            ((fail_count++))
            continue
        fi

        # Clean up the repacked wheel
        rm -f "${repacked_whl}"

        # Upload transformed wheels with SHA256 checksum metadata
        echo "  Uploading to ${OUTPUT_BUCKET}..."
        for variant_whl in "${output_dir}"/*.whl; do
            if [[ -f "${variant_whl}" ]]; then
                whl_name=$(basename "${variant_whl}")
                # Compute SHA256 checksum for metadata
                sha256_checksum=$(sha256sum "${variant_whl}" | awk '{print $1}')
                if aws s3 cp ${DRY_RUN_FLAG} "${variant_whl}" "${OUTPUT_BUCKET}" \
                    --acl public-read \
                    --metadata "checksum-sha256=${sha256_checksum}" 2>/dev/null; then
                    echo "  SUCCESS: ${whl_name} (sha256: ${sha256_checksum})"
                    ((success_count++))
                else
                    echo "  FAIL: Upload failed for ${whl_name}"
                    ((fail_count++))
                fi
                rm -f "${variant_whl}"
            fi
        done
    done
done

echo ""
echo "========================================"
echo "Promotion Summary"
echo "========================================"
echo "Successful: ${success_count}"
echo "Skipped:    ${skip_count}"
echo "Failed:     ${fail_count}"
echo "========================================"

if [[ ${fail_count} -gt 0 ]]; then
    exit 1
fi
