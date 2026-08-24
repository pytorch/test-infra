#!/usr/bin/env bash
# Trigger the "Green Light Review" scan workflow in CI on a feature branch and watch it.
# Unlike test.sh (which runs the scan locally with your own creds), this exercises the real
# Actions permission/token surface: the minted App token, OIDC role/arc, the ClickHouse
# secrets, and the dispatch of greenlight-pr-review.yml -- none of which the local run touches.
#
# Requires: gh authenticated with actions:write on pytorch/test-infra.
set -euo pipefail

WORKFLOW="greenlight-review.yml"
BRANCH="jeanschmidt/greenlight_meta_own_fleet"

# Newest run before dispatch, so the run we trigger can be told apart from earlier ones
# (workflow_dispatch returns no run id).
prev_id=$(gh run list --repo "pytorch/test-infra" --workflow "$WORKFLOW" --branch "$BRANCH" \
  --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // ""')

# Inputs mirror test.sh: cap at one dispatch, dispatch this branch's reviewer, verbose logs.
gh workflow run "$WORKFLOW" \
  --repo "pytorch/test-infra" \
  --ref "$BRANCH" \
  -f max=1 \
  -f ref="$BRANCH" \
  -f log_level=DEBUG
# Optional: -f pr=191819  -f requester=jeanschmidt  -f timeout_minutes=45

echo "Dispatched $WORKFLOW @ $BRANCH; waiting for the run to register..."
run_id=""
for _ in $(seq 1 30); do
  cur_id=$(gh run list --repo "pytorch/test-infra" --workflow "$WORKFLOW" --branch "$BRANCH" \
    --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // ""')
  if [ -n "$cur_id" ] && [ "$cur_id" != "$prev_id" ]; then
    run_id="$cur_id"
    break
  fi
  sleep 2
done

if [ -z "$run_id" ]; then
  echo "Timed out waiting for the run. Check manually:" >&2
  echo "  gh run list --repo pytorch/test-infra --workflow $WORKFLOW --branch $BRANCH" >&2
  exit 1
fi

echo "Run: $(gh run view "$run_id" --repo "pytorch/test-infra" --json url --jq '.url')"
# Streams job/step progress and exits non-zero if the run fails, so a permission/token
# error surfaces as a failed exit rather than a silent CI red.
gh run watch "$run_id" --repo "pytorch/test-infra" --exit-status
