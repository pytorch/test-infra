#!/usr/bin/env bash
# Buildkite wrapper for the CRCR callback reporter.
#
# Maps Buildkite-native env vars to the CI-neutral env vars expected by
# report_callback.py, mints a Buildkite OIDC token, and calls the script.
#
# Usage (in a Buildkite step command):
#   DELIVERY_ID_OVERRIDE="<upstream SHA>" \
#   EVENT_TYPE_OVERRIDE="nightly" \
#   CONCLUSION="success" \
#     bash .github/actions/cross-repo-ci-relay-callback/report_callback_buildkite.sh
#
# Required Buildkite env (set automatically by the agent):
#   BUILDKITE_BUILD_ID, BUILDKITE_RETRY_COUNT, BUILDKITE_PIPELINE_SLUG,
#   BUILDKITE_BUILD_URL, BUILDKITE_LABEL or BUILDKITE_STEP_KEY
#
# Required caller-set env:
#   STATUS (default: completed), CONCLUSION, DELIVERY_ID_OVERRIDE, EVENT_TYPE_OVERRIDE

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export SCHEMA_VERSION="${SCHEMA_VERSION:-1}"
export STATUS="${STATUS:-completed}"
export CALLBACK_URL="${CALLBACK_URL:-https://gwuj7w5coh4y4l66urspge6mnm0pwaxq.lambda-url.us-east-1.on.aws/github/callback/}"
export MAX_TIME="${MAX_TIME:-10}"

# Map Buildkite env -> CI-neutral env
export RUN_ID="${BUILDKITE_BUILD_ID}"
export RUN_ATTEMPT=$(( ${BUILDKITE_RETRY_COUNT:-0} + 1 ))
export WORKFLOW_NAME="${BUILDKITE_PIPELINE_SLUG}"
export WORKFLOW_URL="${BUILDKITE_BUILD_URL}"
export JOB_NAME="${BUILDKITE_LABEL:-${BUILDKITE_STEP_KEY:-unknown}}"
export CHECK_RUN_ID="${BUILDKITE_BUILD_ID}-${RUN_ATTEMPT}"

# Map Buildkite exit status -> conclusion (if not already set)
if [[ -z "${CONCLUSION:-}" && -n "${BUILDKITE_COMMAND_EXIT_STATUS:-}" ]]; then
  if [[ "${BUILDKITE_COMMAND_EXIT_STATUS}" -eq 0 ]]; then
    CONCLUSION="success"
  else
    CONCLUSION="failure"
  fi
fi
export CONCLUSION

# Mint Buildkite OIDC token (same audience as GitHub OIDC)
export OIDC_TOKEN
OIDC_TOKEN=$(buildkite-agent oidc request-token \
  --audience "pytorch-cross-repo-ci-relay" \
  --lifetime 300)

python3 "${SCRIPT_DIR}/report_callback.py"
