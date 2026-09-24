#!/bin/bash
# PreToolUse hook for Write: only allow writing to the actions output file.
set -euo pipefail
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
if [[ "$file_path" == "/tmp/claude-infra-alerts-actions.json" ]]; then
  exit 0
fi
echo "Write is restricted to /tmp/claude-infra-alerts-actions.json. Got: $file_path" >&2
exit 2
