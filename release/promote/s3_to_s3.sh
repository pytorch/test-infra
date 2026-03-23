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

# R2_ONLY: set to "true" to skip S3-to-S3 copy and only promote to R2
R2_ONLY=${R2_ONLY:-false}

if [[ "${R2_ONLY}" != "true" ]]; then
    aws_promote "${PACKAGE_NAME}"
else
    echo "+ R2_ONLY=true, skipping S3-to-S3 promotion"
fi

# Also promote to R2 (Cloudflare) if credentials are available
r2_promote "${PACKAGE_NAME}"
