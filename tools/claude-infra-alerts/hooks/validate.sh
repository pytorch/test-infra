#!/bin/bash
# Validate /tmp/claude-infra-alerts-actions.json against the JSON Schema.
# Called by both validate-post-write.sh and validate-on-stop.sh.
#
# Requires `check-jsonschema` to be on PATH. The reusable workflow
# pre-installs it; this hook fails loudly if it isn't there so a missing
# install never silently bypasses validation.
#
# The schema file is staged next to this script by the reusable workflow
# (`.claude/hooks/claude-infra-alerts/actions-schema.json` at runtime),
# distinct from the skill-side copy that Claude reads via SKILL.md.
#
# Returns 0 on valid, 1 on invalid. All output goes to stderr.

set -euo pipefail

ACTIONS_FILE="/tmp/claude-infra-alerts-actions.json"
SCHEMA_FILE="$(dirname "$0")/actions-schema.json"

if [[ ! -f "$ACTIONS_FILE" ]]; then
  echo "ERROR: $ACTIONS_FILE does not exist" >&2
  exit 1
fi

if ! command -v check-jsonschema &>/dev/null; then
  echo "ERROR: check-jsonschema is not on PATH; cannot validate schema strictly." >&2
  echo "       The reusable workflow's investigate and apply-actions jobs both" >&2
  echo "       pre-install it; if you're seeing this, the install step failed." >&2
  exit 1
fi

# Rely on check-jsonschema's exit code; its stdout/stderr wording is not
# a stable API.
if check-jsonschema --schemafile "$SCHEMA_FILE" "$ACTIONS_FILE" >&2; then
  count=$(jq '.actions | length' "$ACTIONS_FILE")
  echo "Valid JSON with $count action(s)" >&2
  exit 0
else
  exit 1
fi
