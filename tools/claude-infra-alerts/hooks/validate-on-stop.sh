#!/bin/bash
# Stop hook: validate actions JSON before allowing Claude to stop.
# Exits 2 if invalid (Claude must fix before stopping).
set -euo pipefail
input=$(cat)
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // false')
if [[ "$stop_hook_active" == "true" ]]; then
  exit 0
fi

if ! "$(dirname "$0")/validate.sh"; then
  echo "Fix the JSON before stopping." >&2
  exit 2
fi
exit 0
