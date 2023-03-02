#!/usr/bin/env bash

############################################################################
#
# Upload versions of pytorch-triton-rocm to download.pytorch.org
#
# Usage:
#     bash mirror_pytorch_triton_rocm.sh
#
############################################################################

set -eou pipefail

VERSION=${VERSION:-2.0.0.dev20230218}
TMPDIR=$(mktemp -d)

trap 'rm -rf ${TMPDIR};' EXIT

(
    pushd "${TMPDIR}" >/dev/null
    for abi in 37m 38 39 310 311; do
        (
            echo -n "+ Downloading py${abi/m/}..."
            pip download \
                --quiet \
                --pre \
                --platform manylinux2014_x86_64 \
                --python-version ${abi/m/} \
                --abi "cp${abi}" \
                --no-deps \
                "pytorch-triton-rocm==${VERSION}"
            echo "done"
        )
    done
    popd >/dev/null
)

echo

# Dry run by default
DRY_RUN=${DRY_RUN:-enabled}
DRY_RUN_FLAG="--dryrun"
if [[ $DRY_RUN = "disabled" ]]; then
    DRY_RUN_FLAG=""
fi
BASE_BUCKET=${BASE_BUCKET:-s3://pytorch/whl}

for channel in test nightly; do
    echo "+ Uploading whls to ${BASE_BUCKET}/${channel}/"
    (
        set -x
        aws s3 sync \
            ${DRY_RUN_FLAG} \
            --only-show-errors \
            --acl public-read \
            ${TMPDIR}/ \
            "${BASE_BUCKET}/${channel}/"
    )
done
