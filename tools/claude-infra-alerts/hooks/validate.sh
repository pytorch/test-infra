#!/bin/bash
# Validate /tmp/claude-infra-alerts-actions.json against the JSON Schema.
# Called by both validate-post-write.sh and validate-on-stop.sh.
#
# Uses `check-jsonschema` (pip-installable) if available, otherwise falls back
# to a jq-based structural check so CI works without extra dependencies.
#
# Returns 0 on valid, 1 on invalid. All output goes to stderr.

set -euo pipefail

ACTIONS_FILE="/tmp/claude-infra-alerts-actions.json"
SCHEMA_FILE="$(dirname "$0")/../skill/actions-schema.json"

if [[ ! -f "$ACTIONS_FILE" ]]; then
  echo "ERROR: $ACTIONS_FILE does not exist" >&2
  exit 1
fi

# --- Try check-jsonschema first (precise, good error messages) ---
if command -v check-jsonschema &>/dev/null; then
  if check-jsonschema --schemafile "$SCHEMA_FILE" "$ACTIONS_FILE" 2>&1 | tee /dev/stderr | grep -q "ok"; then
    count=$(jq '.actions | length' "$ACTIONS_FILE")
    echo "Valid JSON with $count action(s)" >&2
    exit 0
  else
    exit 1
  fi
fi

# --- Fallback: jq-based validation ---

if ! jq empty "$ACTIONS_FILE" 2>/dev/null; then
  echo "ERROR: $ACTIONS_FILE is not valid JSON" >&2
  exit 1
fi

if ! jq -e '.actions | type == "array"' "$ACTIONS_FILE" >/dev/null 2>&1; then
  echo "ERROR: JSON must have a top-level 'actions' array" >&2
  exit 1
fi

count=$(jq '.actions | length' "$ACTIONS_FILE")

if [[ "$count" -eq 0 ]]; then
  echo "Valid JSON with 0 action(s)" >&2
  exit 0
fi

errors=0
for i in $(seq 0 $((count - 1))); do
  action_type=$(jq -r ".actions[$i].type // empty" "$ACTIONS_FILE")

  if [[ -z "$action_type" ]]; then
    echo "ERROR: action[$i] missing required field 'type'" >&2
    errors=$((errors + 1))
    continue
  fi

  case "$action_type" in
    create)
      for field in repo title summary labels details; do
        val=$(jq -r ".actions[$i].$field // empty" "$ACTIONS_FILE")
        if [[ -z "$val" ]]; then
          echo "ERROR: action[$i] (create) missing required field '$field'" >&2
          errors=$((errors + 1))
        fi
      done
      ;;
    update)
      for field in repo issue_number details; do
        val=$(jq -r ".actions[$i].$field // empty" "$ACTIONS_FILE")
        if [[ -z "$val" ]]; then
          echo "ERROR: action[$i] (update) missing required field '$field'" >&2
          errors=$((errors + 1))
        fi
      done
      ;;
    close)
      for field in repo issue_number comment; do
        val=$(jq -r ".actions[$i].$field // empty" "$ACTIONS_FILE")
        if [[ -z "$val" ]]; then
          echo "ERROR: action[$i] (close) missing required field '$field'" >&2
          errors=$((errors + 1))
        fi
      done
      ;;
    noop)
      for field in repo issue_number reason; do
        val=$(jq -r ".actions[$i].$field // empty" "$ACTIONS_FILE")
        if [[ -z "$val" ]]; then
          echo "ERROR: action[$i] (noop) missing required field '$field'" >&2
          errors=$((errors + 1))
        fi
      done
      ;;
    *)
      echo "ERROR: action[$i] has invalid type '$action_type' (must be create|update|close|noop)" >&2
      errors=$((errors + 1))
      ;;
  esac
done

if [[ "$errors" -gt 0 ]]; then
  echo "INVALID: $errors error(s) in $count action(s)" >&2
  exit 1
fi

echo "Valid JSON with $count action(s)" >&2
exit 0
