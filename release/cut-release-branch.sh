#!/usr/bin/env bash

: '
So you are looking to cut a release branch? Well you came
to the right script.

This script can be used to cut any branch on any repository

For `pytorch/pytorch` usage would be like:
> DRY_RUN=disabled cut-release-branch.sh

For `pytorch/builder`, `pytorch/test-infra` or domains usage would be like:
> DRY_RUN=disabled GIT_BRANCH_TO_CUT_FROM=main RELEASE_VERSION=2.1 cut-release-branch.sh
'

set -eou pipefail

GIT_TOP_DIR=$(git rev-parse --show-toplevel)
GIT_REMOTE=${GIT_REMOTE:-origin}
GIT_BRANCH_TO_CUT_FROM=${GIT_BRANCH_TO_CUT_FROM:-viable/strict}

# should output something like 1.11
RELEASE_VERSION=${RELEASE_VERSION:-$(cut -d'.' -f1-2 "${GIT_TOP_DIR}/version.txt")}
TEST_INFRA_BRANCH=${TEST_INFRA_BRANCH:-"release/${RELEASE_VERSION}"}

DRY_RUN_FLAG="--dry-run"
if [[ ${DRY_RUN:-enabled} == "disabled" ]]; then
    DRY_RUN_FLAG=""
fi

function update_test_infra_branch() {
    # Change all GitHub Actions to reference the test-infra release branch
    # as opposed to main as copied from pytorch/vision/packaging/cut_release.sh
    for i in .github/workflows/*.yml; do
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' -e s#@main#@"${TEST_INFRA_BRANCH}"# $i;
        sed -i '' -e s#test-infra-ref:[[:space:]]main#"test-infra-ref: ${TEST_INFRA_BRANCH}"# $i;
      else
        sed -i -e s#@main#@"${TEST_INFRA_BRANCH}"# $i;
        sed -i -e s#test-infra-ref:[[:space:]]main#"test-infra-ref: ${TEST_INFRA_BRANCH}"# $i;
      fi
    done
}

(
    set -x
    git fetch --all
    git checkout "${GIT_REMOTE}/${GIT_BRANCH_TO_CUT_FROM}"
)

for branch in "release/${RELEASE_VERSION}" "orig/release/${RELEASE_VERSION}"; do
    if git rev-parse --verify "${branch}" >/dev/null 2>/dev/null; then
        echo "+ Branch ${branch} already exists, skipping..."
        continue
    else
        (
            set -x
            git checkout "${GIT_REMOTE}/${GIT_BRANCH_TO_CUT_FROM}"
            git checkout -b "${branch}"
            # Apply common steps to automate release
            update_test_infra_branch

            if [[ "${DRY_RUN:-enabled}" == "disabled" ]]; then
                git add .github/workflows/*.yml
                git commit -m "[RELEASE-ONLY CHANGES] Branch Cut for Release {RELEASE_VERSION}"
                git push "${GIT_REMOTE}" "${branch}"
            fi
        )
    fi
done
