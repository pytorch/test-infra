#!/usr/bin/env bash
# Run from tools/ by the report job of .github/workflows/greenlight-policy-replay.yml, whose step env it reads.
set -euo pipefail
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo "invalid pull request number: '$PR_NUMBER'" >&2; exit 1; }
runs="$RUNNER_TEMP/runs"
# The run directories are listed from the replicates rather than globbed, one per
# replay job, so a job that uploaded nothing is reported as a failed run.
numbers=$(jq -ern --argjson r "$REPLICATES" '$r[]')
base=() change=()
while IFS= read -r n; do
  base+=("$runs/greenlight-replay-base-$n")
  change+=("$runs/greenlight-replay-change-$n")
done <<<"$numbers"
comment="$RUNNER_TEMP/greenlight-policy-replay.md"
PYTHONPATH=. python3 -m torchci.greenlight_replay.compare \
  --base "${base[@]}" \
  --change "${change[@]}" \
  --base-sha "$BASE_SHA" \
  --head-sha "$HEAD_SHA" \
  --run-url "$RUN_URL" \
  --output "$comment"
cat "$comment" >>"$GITHUB_STEP_SUMMARY"
bash "$(dirname "$0")/greenlight_policy_replay_comment.sh" "$comment"
