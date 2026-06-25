#!/usr/bin/bash
# Mirrors pytorch-gha-infra/macos-runners/scripts/create-runner-user.sh so the
# runner user exists in the baked AMI. Kept in sync manually.

set -eou pipefail

RUNNER_USER="${RUNNER_USER:-runner}"
RUNNER_USER_DIR="/Users/${RUNNER_USER}"

DSCL_CREATE="dscl . -create ${RUNNER_USER_DIR}"

mkdir -p "/Local/Users/${RUNNER_USER}"

if ! id -u "${RUNNER_USER}" >/dev/null 2>/dev/null; then
    echo "+ Creating the runner user (${RUNNER_USER})"
    (
        set -x
        ${DSCL_CREATE}
        ${DSCL_CREATE} UserShell /bin/zsh
        ${DSCL_CREATE} RealName "Runner Person"
        ${DSCL_CREATE} UniqueID 1001
        ${DSCL_CREATE} PrimaryGroupID 1000
        ${DSCL_CREATE} NFSHomeDirectory "/Local/Users/${RUNNER_USER}"
        dscl . -passwd "${RUNNER_USER_DIR}" password
        dscl . -append /Groups/admin GroupMembership "${RUNNER_USER}"
        mkdir -p "${RUNNER_USER_DIR}"
        if [[ ! -d "${RUNNER_USER_DIR}" ]]; then
            echo "error: Something went wrong creating the user ${RUNNER_USER}"
            exit 1
        fi
    )
fi
