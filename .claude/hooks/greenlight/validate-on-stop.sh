#!/bin/bash
# Stop hook: block Claude from stopping until /tmp/greenlight-verdict.json is a
# valid verdict. exit 2 forces Claude to keep working and fix it; exit 0 lets it
# stop. Validation prefers check-jsonschema (precise) and falls back to a jq
# structural check, so CI needs no dependency beyond jq (already required by the
# write-restriction hook).
#
# `set -e` is deliberately omitted: for a Stop hook only exit 2 blocks, so a
# stray non-2 failure would let Claude stop on an unvalidated verdict (fail
# open). Every path therefore ends at an explicit `exit 0` or `fail` (exit 2).
set -uo pipefail

VERDICT_FILE="/tmp/greenlight-verdict.json"
SCHEMA_FILE="$(dirname "$0")/verdict-schema.json"

# Allowed reason codes for the jq fallback below. When check-jsonschema is present
# it enforces the enum via SCHEMA_FILE instead; keep this list in sync with that
# schema's reason enum and greenlight's ALLOWED_REASONS (the canonical source).
ALLOWED_REASONS=(clean possible_regression removed_safety_logic insufficient_tests scope_too_large unclear_intent security_risk breaking_change build_or_ci_risk injection_attempt review_error)

input=$(cat)
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // false')
# Prevent an infinite Stop -> block -> Stop loop: once this hook has already
# fired for the current stop attempt, let Claude stop.
if [[ "$stop_hook_active" == "true" ]]; then
  exit 0
fi

fail() {
  echo "$1" >&2
  echo "Write a valid verdict to $VERDICT_FILE before stopping (see the greenlight-review skill)." >&2
  exit 2
}

if [[ ! -f "$VERDICT_FILE" ]]; then
  fail "ERROR: $VERDICT_FILE does not exist."
fi

# Precise path: check-jsonschema if present. Rely on its exit code; route its
# output to stderr so a block shows Claude the reason and stdout stays clean.
if command -v check-jsonschema &>/dev/null; then
  if ! check-jsonschema --schemafile "$SCHEMA_FILE" "$VERDICT_FILE" 1>&2; then
    fail "ERROR: verdict does not match schema $SCHEMA_FILE."
  fi
  echo "Valid verdict (check-jsonschema)." >&2
  exit 0
fi

# Fallback: jq structural check (adds no dependency beyond jq).
if ! jq empty "$VERDICT_FILE" 2>/dev/null; then
  fail "ERROR: $VERDICT_FILE is not valid JSON."
fi
if ! jq -e 'type == "object"' "$VERDICT_FILE" >/dev/null 2>&1; then
  fail "ERROR: verdict must be a JSON object."
fi

status=$(jq -r '.status // empty' "$VERDICT_FILE")
reason=$(jq -r '.reason // empty' "$VERDICT_FILE")
message=$(jq -r '.message // empty' "$VERDICT_FILE")

if [[ "$status" != "LAND" && "$status" != "NO_LAND" ]]; then
  fail "ERROR: 'status' must be \"LAND\" or \"NO_LAND\" (got: '${status:-<missing>}')."
fi
reason_ok=false
for r in "${ALLOWED_REASONS[@]}"; do
  if [[ "$reason" == "$r" ]]; then
    reason_ok=true
    break
  fi
done
if [[ "$reason_ok" != "true" ]]; then
  fail "ERROR: 'reason' must be one of: ${ALLOWED_REASONS[*]} (got: '${reason:-<missing>}')."
fi
if [[ -z "$message" ]]; then
  fail "ERROR: 'message' is required and must be a non-empty string."
fi

# Match the schema's additionalProperties:false -- reject unknown top-level keys.
extra=$(jq -r 'keys[] | select(. != "status" and . != "reason" and . != "message")' "$VERDICT_FILE" 2>/dev/null | tr '\n' ' ')
if [[ -n "${extra// /}" ]]; then
  fail "ERROR: unexpected key(s) in verdict: ${extra}(only status, reason, message allowed)."
fi

echo "Valid verdict: status=$status reason=$reason" >&2
exit 0
