#!/usr/bin/env bash
#
# Script to download PyTorch wheels from test channel, transform them using
# variant-repack, and upload to the variant staging bucket.
#
# This script is used to create wheel variants for the PyTorch ecosystem.
# It requires the variant-repack tool to be installed.
#
# Environment variables:
#   PACKAGE_NAME    - Package name (default: torch)
#   PACKAGE_VERSION - Package version (default: 1.0.0)
#   VERSION_SUFFIX  - URL-encoded version suffix (e.g., %2Bcu128 for +cu128)
#   PLATFORM        - Platform filter (e.g., manylinux_2_28_x86_64)
#   ARCH            - Architecture (e.g., cpu, cu126, cu128, cu130, rocm7.0, xpu)
#   VARIANT_CONFIG  - Variant config name in variant_config.toml (default: same as ARCH with dots removed)
#   PYTORCH_RELEASE - PyTorch release version for configs (default: 2.10)
#   DRY_RUN         - Set to "disabled" to actually upload (default: enabled)
#   VARIANT_REPACK_DIR - Path to variant-repack checkout (default: ./variant-repack)
#   OUTPUT_BUCKET   - S3 bucket path for output (default: s3://pytorch/whl/test/variant/)

set -eou pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Package configuration
PACKAGE_NAME=${PACKAGE_NAME:-torch}
PACKAGE_VERSION=${PACKAGE_VERSION:-1.0.0}
VERSION_SUFFIX=${VERSION_SUFFIX:-}
PLATFORM=${PLATFORM:-}
ARCH=${ARCH:-cpu}

# Variant-repack configuration
PYTORCH_RELEASE=${PYTORCH_RELEASE:-2.10}
VARIANT_REPACK_DIR=${VARIANT_REPACK_DIR:-./variant-repack}
# Remove dots from ARCH to get variant config name (e.g., rocm7.0 -> rocm70)
VARIANT_CONFIG=${VARIANT_CONFIG:-${ARCH//./}}
OUTPUT_BUCKET=${OUTPUT_BUCKET:-s3://pytorch/whl/test/variant/}

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

echo "========================================"
echo "Variant Wheel Upload Configuration"
echo "========================================"
echo "Package:         ${PACKAGE_NAME}"
echo "Version:         ${PACKAGE_VERSION}"
echo "Version Suffix:  ${VERSION_SUFFIX}"
echo "Platform:        ${PLATFORM}"
echo "Architecture:    ${ARCH}"
echo "Variant Config:  ${VARIANT_CONFIG}"
echo "PyTorch Release: ${PYTORCH_RELEASE}"
echo "Output Bucket:   ${OUTPUT_BUCKET}"
echo "========================================"

# Retrieve packages from test index
echo "Retrieving packages for ${PACKAGE_NAME} ${PACKAGE_VERSION}${VERSION_SUFFIX} from test index..."
pkgs_to_promote=$(\
    curl -fsSL "https://download.pytorch.org/whl/test/${ARCH}/${PACKAGE_NAME}/index.html" \
        | grep "${PACKAGE_NAME}-${PACKAGE_VERSION}${VERSION_SUFFIX}-" \
        | grep "${PLATFORM}" \
        | cut -d '"' -f2 \
        | cut -d "#" -f1
) || {
    echo "ERROR: Failed to retrieve package list or no packages found."
    exit 1
}

if [[ -z "${pkgs_to_promote}" ]]; then
    echo "ERROR: No packages found matching criteria."
    exit 1
fi

echo "Found packages:"
echo "${pkgs_to_promote}"
echo ""

# Create temporary directories
tmp_dir="$(mktemp -d)"
output_dir="$(mktemp -d)"
trap 'rm -rf ${tmp_dir} ${output_dir}' EXIT

# Dry run by default
DRY_RUN=${DRY_RUN:-enabled}
DRY_RUN_FLAG="--dryrun"
if [[ "${DRY_RUN}" == "disabled" ]]; then
    DRY_RUN_FLAG=""
fi

for pkg in ${pkgs_to_promote}; do
    pkg_basename="$(basename "${pkg}")"
    # Decode URL-encoded characters (e.g., %2B -> +)
    decoded_fname=$(echo "${pkg_basename}" | sed "s/%2B/+/g")
    orig_pkg="${tmp_dir}/${decoded_fname}"

    echo "----------------------------------------"
    echo "Processing: ${decoded_fname}"
    echo "----------------------------------------"

    # Download the wheel
    echo "Downloading wheel..."
    (
        set -x
        curl -fSL -o "${orig_pkg}" "https://download.pytorch.org${pkg}"
    )

    # Unpack and repack wheel to ensure consistent format
    echo "Repacking wheel..."
    pushd "${tmp_dir}" > /dev/null
    mkdir -p unpacked
    unzip -q "${orig_pkg}" -d unpacked
    rm "${orig_pkg}"
    wheel pack unpacked -d "${tmp_dir}" > /dev/null
    rm -rf unpacked
    popd > /dev/null

    # Find the repacked wheel
    repacked_whl=$(find "${tmp_dir}" -name "*.whl" -type f | head -1)
    if [[ -z "${repacked_whl}" ]]; then
        echo "ERROR: Failed to find repacked wheel"
        exit 1
    fi

    # Transform using variant-repack
    echo "Transforming wheel with variant-repack..."
    (
        set -x
        variant_repack build \
            -i "${repacked_whl}" \
            -o "${output_dir}" \
            --pyproject-toml "${PYPROJECT_TOML}" \
            --variant-config-toml "${VARIANT_CONFIG_TOML}" \
            --variant-config-name "${VARIANT_CONFIG}" \
            --metadata-config-name "${PACKAGE_NAME}"
    )

    # Clean up the repacked wheel
    rm -f "${repacked_whl}"

    # Upload transformed wheels
    echo "Uploading transformed wheels to ${OUTPUT_BUCKET}..."
    for variant_whl in "${output_dir}"/*.whl; do
        if [[ -f "${variant_whl}" ]]; then
            (
                set -x
                aws s3 cp ${DRY_RUN_FLAG} "${variant_whl}" "${OUTPUT_BUCKET}" --acl public-read
            )
            rm -f "${variant_whl}"
        fi
    done

    echo "Completed: ${decoded_fname}"
done

echo ""
echo "========================================"
echo "Variant wheel upload completed!"
echo "========================================"
