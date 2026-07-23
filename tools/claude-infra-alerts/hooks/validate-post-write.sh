#!/bin/bash
# PostToolUse hook for Write: validate actions JSON after writes.
# Always exits 0 (feedback only — file is already written).
# Validation output goes to stderr so Claude sees it.
set -euo pipefail
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [[ "$file_path" == "/tmp/claude-infra-alerts-actions.json" ]]; then
  "$(dirname "$0")/validate.sh" || true
fi

exit 0
