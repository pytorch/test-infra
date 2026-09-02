#!/usr/bin/env bash

set -eou pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
source "${DIR}/common_utils.sh"

# Allow for users to pass PACKAGE_NAME
# For use with other packages, i.e. torchvision, etc.
PACKAGE_NAME=${PACKAGE_NAME:-torch}
PACKAGE_TYPE=${PACKAGE_TYPE:-whl}

PYTORCH_S3_BUCKET=${PYTORCH_S3_BUCKET:-s3://pytorch}
FROM=${FROM:-test}
TO=${TO:-}
DEFAULT_S3_FROM="${PYTORCH_S3_BUCKET}/${PACKAGE_TYPE}/${FROM}"
DEFAULT_S3_TO="${PYTORCH_S3_BUCKET}/${PACKAGE_TYPE}/${TO}"
PYTORCH_S3_FROM=${PYTORCH_S3_FROM:-${DEFAULT_S3_FROM}}
PYTORCH_S3_TO=${PYTORCH_S3_TO:-${DEFAULT_S3_TO}}

# An inherited PYTORCH_S3_FROM/TO silently wins over PACKAGE_TYPE. promote.sh
# invokes this script once per package with a different PACKAGE_TYPE each time,
# so a leftover export from an earlier shell command sends every later package to
# the wrong channel -- libtorch copying whl/test -> whl/, matching nothing and
# promoting nothing, while still exiting 0.
if [[ "${PYTORCH_S3_FROM}" != "${DEFAULT_S3_FROM}" || "${PYTORCH_S3_TO}" != "${DEFAULT_S3_TO}" ]]; then
    echo "- PYTORCH_S3_FROM/TO do not match PACKAGE_TYPE=${PACKAGE_TYPE}:"
    echo "-   from: ${PYTORCH_S3_FROM}   (expected ${DEFAULT_S3_FROM})"
    echo "-   to  : ${PYTORCH_S3_TO}   (expected ${DEFAULT_S3_TO})"
    if [[ "${ALLOW_S3_PATH_OVERRIDE:-false}" != "true" ]]; then
        echo "- ERROR: refusing to promote. Run 'unset PYTORCH_S3_FROM PYTORCH_S3_TO',"
        echo "-        or set ALLOW_S3_PATH_OVERRIDE=true if the override is deliberate."
        exit 1
    fi
    echo "- ALLOW_S3_PATH_OVERRIDE=true, continuing"
fi

# R2_ONLY: set to "true" to skip the S3-to-S3 copy and only promote to R2.
# The source stays the FROM channel. Mirroring from the prod destination instead
# would keep R2 in sync with what is literally live on S3, but aws_promote
# copies test -> prod server-side, so the two hold the same objects, and for a
# stable release the prod prefix is whl/ -- the parent of whl/nightly/. Listing
# that enumerates months of nightlies to find 282 files.
# Set PYTORCH_S3_FROM explicitly if you do need to mirror from prod.
R2_ONLY=${R2_ONLY:-false}

# SKIP_CHECKSUMS: set to "true" to skip the SHA256 recomputation pass. Kept
# separate from R2_ONLY: re-running the R2 mirror after a failure is common, and
# that says nothing about whether the checksum pass has run. It has not, if an
# earlier attempt died in r2_promote -- the checksum pass is the step after it.
SKIP_CHECKSUMS=${SKIP_CHECKSUMS:-false}

if [[ "${R2_ONLY}" != "true" ]]; then
    aws_promote "${PACKAGE_NAME}"
else
    echo "+ R2_ONLY=true, skipping S3-to-S3 promotion; mirroring ${PYTORCH_S3_FROM} to R2"
fi

# Promote to R2 (Cloudflare) before the slow SHA256 recomputation step so R2
# is not blocked waiting on per-wheel downloads on the S3 destination.
r2_promote "${PACKAGE_NAME}"

# Finally, recompute SHA256 checksum metadata on the S3 destination wheels.
# This is the slowest step (downloads every wheel from S3) and runs last so
# it does not delay the R2 upload above.
if [[ "${SKIP_CHECKSUMS}" != "true" ]]; then
    aws_set_checksums "${PACKAGE_NAME}"
fi
