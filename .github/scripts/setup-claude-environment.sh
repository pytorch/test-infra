#!/bin/bash
# setup-claude-environment.sh
# Creates the 'bedrock' GitHub environment with branch protection for Claude Code workflows.
# If the environment already exists, validates its settings match expected configuration.
#
# Usage: ./setup-claude-environment.sh [--force] <org/repo>
# Example: ./setup-claude-environment.sh pytorch/tutorials
#          ./setup-claude-environment.sh --force pytorch/tutorials
#
# Options:
#   --force   Overwrite existing environment settings if they differ from expected.
#             On mismatch without --force, the script shows the diff and prompts
#             the user to re-run with --force.
#
# Prerequisites:
#   - gh CLI authenticated with admin access to the target repo
#   - Claude GitHub App installed on the repo (fburl.com/1b49tng7)

set -euo pipefail

FORCE=false
if [ "${1:-}" = "--force" ]; then
  FORCE=true
  shift
fi

if [ $# -ne 1 ]; then
  echo "Usage: $0 <org/repo>"
  echo "Example: $0 pytorch/tutorials"
  exit 1
fi

REPO="$1"

# Validate org is pytorch or meta-pytorch
ORG="${REPO%%/*}"
if [[ "$ORG" != "pytorch" && "$ORG" != "meta-pytorch" ]]; then
  echo "Error: org must be 'pytorch' or 'meta-pytorch', got '$ORG'"
  exit 1
fi

# Check if environment already exists
ENV_RESPONSE=$(gh api "repos/$REPO/environments/bedrock" 2>/dev/null || echo "NOT_FOUND")

if [ "$ENV_RESPONSE" != "NOT_FOUND" ]; then
  echo "'bedrock' environment already exists on $REPO. Validating settings..."

  ERRORS=()

  # Check deployment_branch_policy
  PROTECTED=$(echo "$ENV_RESPONSE" | jq -r '.deployment_branch_policy.protected_branches')
  CUSTOM=$(echo "$ENV_RESPONSE" | jq -r '.deployment_branch_policy.custom_branch_policies')

  if [ "$PROTECTED" != "false" ]; then
    ERRORS+=("deployment_branch_policy.protected_branches: expected 'false', got '$PROTECTED'")
  fi
  if [ "$CUSTOM" != "true" ]; then
    ERRORS+=("deployment_branch_policy.custom_branch_policies: expected 'true', got '$CUSTOM'")
  fi

  # Check branch policies — should be exactly ["main"]
  BRANCH_POLICIES=$(gh api "repos/$REPO/environments/bedrock/deployment-branch-policies" \
    --jq '[.branch_policies[].name] | sort')
  EXPECTED_BRANCHES='["main"]'

  if [ "$BRANCH_POLICIES" != "$EXPECTED_BRANCHES" ]; then
    ERRORS+=("deployment branch policies: expected $EXPECTED_BRANCHES, got '$BRANCH_POLICIES'")
  fi

  if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    echo "Mismatch: existing 'bedrock' environment settings differ from expected:"
    echo ""
    printf "  %-50s %-20s %-20s\n" "SETTING" "EXPECTED" "ACTUAL"
    printf "  %-50s %-20s %-20s\n" "-------" "--------" "------"
    for err in "${ERRORS[@]}"; do
      echo "  - $err"
    done
    echo ""

    if [ "$FORCE" = true ]; then
      echo "--force specified. Overwriting remote settings..."
    else
      echo "To overwrite remote settings with expected values, re-run with --force:"
      echo "  $0 --force $REPO"
      exit 1
    fi
  else
    echo "Settings match. Nothing to do."
    exit 0
  fi
fi

create_environment() {
  echo "Configuring 'bedrock' environment on $REPO..."

  gh api --method PUT "repos/$REPO/environments/bedrock" \
    --input - >/dev/null <<'EOF'
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
EOF

  # Remove any existing branch policies before adding ours
  EXISTING_POLICIES=$(gh api "repos/$REPO/environments/bedrock/deployment-branch-policies" \
    --jq '.branch_policies[].id' 2>/dev/null || true)
  for policy_id in $EXISTING_POLICIES; do
    gh api --method DELETE \
      "repos/$REPO/environments/bedrock/deployment-branch-policies/$policy_id" \
      >/dev/null 2>&1 || true
  done

  echo "Restricting deployments to 'main' branch only..."
  gh api --method POST "repos/$REPO/environments/bedrock/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null

  echo ""
  echo "Done. 'bedrock' environment configured on $REPO with deployment restricted to main."
}

create_environment

echo ""
echo "Remaining manual steps:"
echo "  1. Add 'repo:$REPO:environment:bedrock' to the IAM trust policy in configerator"
echo "     File: raw_configs/cloud/strata/fbossci/iam/main.tf"
echo "     Then: cloud tf plan fbossci --strata iam --configerator-root ~/configerator/"
echo "  2. Install Claude GitHub App on the repo: fburl.com/1b49tng7"
echo "  3. Add CLAUDE.md and .github/workflows/claude-code.yml to the repo"
