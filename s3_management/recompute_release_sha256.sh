#!/usr/bin/env bash
#
# recompute_release_sha256.sh - Backfill missing SHA256 checksums for prod
# PyTorch release packages across all published accelerator subfolders.
#
# Wraps manage_v2.py --recompute-sha256-pattern. For each package/version pair
# below, and for each accelerator subfolder under the prod whl/ prefix that
# actually contains that package/version, it downloads the wheels, computes
# SHA256, and stores it as x-amz-meta-checksum-sha256 metadata. Wheels that
# already have a checksum are SKIPPED (manage_v2.py only computes where the
# checksum is missing and never clobbers existing ones). Only the S3 "pytorch"
# bucket is written; R2 is not touched.
#
# Requires AWS credentials with read+write on the "pytorch" bucket and the
# aws CLI for subfolder discovery.
#
# Usage:
#   PREFIX=whl ./recompute_release_sha256.sh [package=version ...]
#
# Package/version pairs may be passed as arguments (name=version). If none are
# given, the built-in defaults below are used. The target channel is set via
# the PREFIX env var (default "whl" = prod/stable; use "whl/test" for RCs).
#
# Examples:
#   # Prod/stable channel, built-in default packages
#   ./recompute_release_sha256.sh
#
#   # Explicit packages/versions on prod
#   ./recompute_release_sha256.sh torch=2.12.1 torchvision=0.27.1
#
#   # Release-candidate channel
#   PREFIX=whl/test ./recompute_release_sha256.sh torch=2.12.1

set -euo pipefail

PREFIX="${PREFIX:-whl}"     # prod/stable channel; use whl/test for RCs
BUCKET="s3://pytorch"

# Package/version pairs to process, one "name version" per entry.
# Defaults used when no arguments are supplied.
PACKAGES=(
  "torch 2.12.1"
  "torchvision 0.27.1"
)

# Override defaults with any "name=version" arguments.
if [ "$#" -gt 0 ]; then
  PACKAGES=()
  for arg in "$@"; do
    if [[ "${arg}" != *=* ]]; then
      echo "ERROR: argument '${arg}' must be in name=version form" >&2
      exit 1
    fi
    PACKAGES+=("${arg/=/ }")
  done
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGE="${SCRIPT_DIR}/manage_v2.py"

echo "INFO: Discovering accelerator subfolders under ${BUCKET}/${PREFIX}/ ..."
# Capture the listing first, then filter it (avoids any SIGPIPE on aws).
# Immediate subdirs only, keep accepted accelerator patterns (cpu/xpu/cu*/rocm*)
root_listing="$(aws s3 ls "${BUCKET}/${PREFIX}/")"
mapfile -t CANDIDATES < <(
  printf '%s\n' "${root_listing}" \
    | awk '/ PRE / {print $2}' \
    | sed 's:/$::' \
    | grep -E '^(cpu|xpu|cu[0-9]+|rocm[0-9]+\.[0-9]+)$' \
    | sort
)

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "ERROR: no accelerator subfolders found under ${BUCKET}/${PREFIX}/" >&2
  exit 1
fi

for pair in "${PACKAGES[@]}"; do
  read -r PACKAGE VERSION <<<"${pair}"

  # Match the version exactly: in wheel filenames the version is followed by
  # '-' (pure), or '+' / '%2B' (local version such as 2.12.1+cu126). The S3 key
  # stores '+' as '%2B'. Escape dots so 2.12.1 does not match 2.12.10.
  VERSION_RE="${PACKAGE}-${VERSION//./\\.}[-+%]"

  # Keep only subfolders that actually contain this package/version.
  # Capture the listing first, then grep it. Piping aws directly into
  # `grep -q` makes grep close the pipe on first match, which makes the aws
  # CLI raise BrokenPipeError and (under pipefail) the match be lost.
  SUBDIRS=()
  for sub in "${CANDIDATES[@]}"; do
    listing="$(aws s3 ls "${BUCKET}/${PREFIX}/${sub}/")"
    if grep -qE "${VERSION_RE}" <<<"${listing}"; then
      SUBDIRS+=("${sub}")
    fi
  done

  if [ "${#SUBDIRS[@]}" -eq 0 ]; then
    echo "WARNING: ${PACKAGE} ${VERSION} not found in any subfolder under ${BUCKET}/${PREFIX}/ - skipping" >&2
    continue
  fi

  echo "INFO: Will process ${PACKAGE} ${VERSION} in: ${SUBDIRS[*]}"

  for sub in "${SUBDIRS[@]}"; do
    echo ""
    echo "==================================================================="
    echo "=== ${PREFIX}/${sub} : ${PACKAGE} ${VERSION}"
    echo "==================================================================="
    python "${MANAGE}" "${PREFIX}" \
      --recompute-sha256-pattern "${sub}" \
      --package-name "${PACKAGE}" \
      --package-version "${VERSION}"
  done

  echo ""
  echo "INFO: Done with ${PACKAGE} ${VERSION} (${#SUBDIRS[@]} subfolder(s))."
done

echo ""
echo "INFO: All packages processed."
