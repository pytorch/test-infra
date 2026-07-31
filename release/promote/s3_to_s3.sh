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
PYTORCH_S3_FROM=${PYTORCH_S3_FROM:-${PYTORCH_S3_BUCKET}/${PACKAGE_TYPE}/${FROM}}
TO=${TO:-}
PYTORCH_S3_TO=${PYTORCH_S3_TO:-${PYTORCH_S3_BUCKET}/${PACKAGE_TYPE}/${TO}}

# R2_ONLY: set to "true" to skip the S3-to-S3 copy and only promote to R2.
# In that mode the S3 prod promotion has already happened, so mirror from the
# prod (destination) location instead of the test channel, keeping R2 in sync
# with what is actually live on S3.
R2_ONLY=${R2_ONLY:-false}

if [[ "${R2_ONLY}" != "true" ]]; then
    aws_promote "${PACKAGE_NAME}"
else
    echo "+ R2_ONLY=true, skipping S3-to-S3 promotion; mirroring ${PYTORCH_S3_TO} to R2"
    PYTORCH_S3_FROM="${PYTORCH_S3_TO}"
fi

# Promote to R2 (Cloudflare) before the slow SHA256 recomputation step so R2
# is not blocked waiting on per-wheel downloads on the S3 destination.
r2_promote "${PACKAGE_NAME}"

# Finally, recompute SHA256 checksum metadata on the S3 destination wheels.
# This is the slowest step (downloads every wheel from S3) and runs last so
# it does not delay the R2 upload above.
if [[ "${R2_ONLY}" != "true" ]]; then
    aws_set_checksums "${PACKAGE_NAME}"
fi
