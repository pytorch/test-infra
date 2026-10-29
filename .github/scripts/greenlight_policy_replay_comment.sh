#!/usr/bin/env bash
# Usage: greenlight_policy_replay_comment.sh <body-file>
# Posts the body on PR_NUMBER in GITHUB_REPOSITORY, or edits the workflow's earlier comment there.
set -euo pipefail
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo "invalid pull request number: '$PR_NUMBER'" >&2; exit 1; }
marker="<!-- greenlight-policy-replay -->"
body=$(mktemp)
{ echo "$marker"; cat "$1"; } >"$body"
# Other workflows comment as the same bot, and anyone can copy the marker, so both must match.
id=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" |
  tail -n 1)
if [[ -n "$id" ]]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -F "body=@$body" >/dev/null
else
  gh api "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" -F "body=@$body" >/dev/null
fi
