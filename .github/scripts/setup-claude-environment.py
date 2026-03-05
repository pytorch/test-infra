#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///
"""
Creates the 'bedrock' GitHub environment with branch protection for Claude Code workflows.
If the environment already exists, validates its settings match expected configuration.

Usage (no clone needed, requires uv >= 0.5.0):
  uv run https://raw.githubusercontent.com/pytorch/test-infra/main/.github/scripts/setup-claude-environment.py <org/repo>
  uv run https://raw.githubusercontent.com/pytorch/test-infra/main/.github/scripts/setup-claude-environment.py --force <org/repo>

Or from a local checkout:
  uv run .github/scripts/setup-claude-environment.py <org/repo>

Prerequisites:
  - gh CLI authenticated with admin access to the target repo
  - Claude GitHub App installed on the repo (fburl.com/1b49tng7)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


ALLOWED_ORGS = ("pytorch", "meta-pytorch")

EXPECTED_DEPLOYMENT_BRANCH_POLICY = {
    "protected_branches": False,
    "custom_branch_policies": True,
}

EXPECTED_BRANCH_NAMES = ["main"]


def gh_api(
    method: str,
    endpoint: str,
    data: dict | None = None,
    check: bool = False,
) -> dict | None:
    """Call the GitHub API via gh CLI and return parsed JSON."""
    cmd = ["gh", "api", "--method", method, endpoint]
    if data is not None:
        cmd.extend(["--input", "-"])
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        input=json.dumps(data) if data else None,
    )
    if result.returncode != 0:
        if check:
            print(f"Error: gh api {method} {endpoint} failed:", file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            sys.exit(1)
        return None
    if not result.stdout.strip():
        return {}
    return json.loads(result.stdout)


def get_environment(repo: str) -> dict | None:
    return gh_api("GET", f"repos/{repo}/environments/bedrock")


def get_branch_policies(repo: str) -> list[str]:
    endpoint = f"repos/{repo}/environments/bedrock/deployment-branch-policies"
    resp = gh_api("GET", endpoint)
    if not resp:
        return []
    return sorted(p["name"] for p in resp.get("branch_policies", []))


def validate_environment(repo: str) -> list[tuple[str, str, str]]:
    """Returns list of (setting, expected, actual) mismatches."""
    env = get_environment(repo)
    if env is None:
        return []  # doesn't exist, nothing to validate

    mismatches = []
    policy = env.get("deployment_branch_policy", {})

    for key, expected in EXPECTED_DEPLOYMENT_BRANCH_POLICY.items():
        actual = policy.get(key)
        if actual != expected:
            mismatches.append(
                (
                    f"deployment_branch_policy.{key}",
                    str(expected),
                    str(actual),
                )
            )

    actual_branches = get_branch_policies(repo)
    if actual_branches != EXPECTED_BRANCH_NAMES:
        mismatches.append(
            (
                "deployment branch policies",
                json.dumps(EXPECTED_BRANCH_NAMES),
                json.dumps(actual_branches),
            )
        )

    return mismatches


def check_admin(repo: str) -> None:
    """Verify we have admin access, required for environment management."""
    resp = gh_api("GET", f"repos/{repo}", check=True)
    perms = (resp or {}).get("permissions", {})
    if not perms.get("admin"):
        print(
            f"Error: admin access required on {repo} to manage environments.\n"
            f"Current permissions: {json.dumps(perms)}",
            file=sys.stderr,
        )
        sys.exit(1)


def create_environment(repo: str) -> None:
    print(f"Configuring 'bedrock' environment on {repo}...")

    check_admin(repo)

    gh_api(
        "PUT",
        f"repos/{repo}/environments/bedrock",
        {
            "deployment_branch_policy": EXPECTED_DEPLOYMENT_BRANCH_POLICY,
        },
        check=True,
    )

    reconcile_branch_policies(repo)

    # Verify the final state
    final_branches = get_branch_policies(repo)
    if final_branches != EXPECTED_BRANCH_NAMES:
        print(
            f"\nWarning: verification failed. Expected {EXPECTED_BRANCH_NAMES}, "
            f"got {final_branches}",
            file=sys.stderr,
        )
        sys.exit(1)

    print(
        f"\nDone. 'bedrock' environment configured on {repo}"
        " with deployment restricted to main."
    )


def reconcile_branch_policies(repo: str) -> None:
    """Add missing and remove unexpected branch policies (delta only)."""
    endpoint = f"repos/{repo}/environments/bedrock/deployment-branch-policies"
    resp = gh_api("GET", endpoint)
    existing = {p["name"]: p["id"] for p in (resp or {}).get("branch_policies", [])}
    expected = set(EXPECTED_BRANCH_NAMES)

    # Remove policies that shouldn't be there
    for name, policy_id in existing.items():
        if name not in expected:
            print(f"  Removing unexpected branch policy: {name}")
            policy_ep = f"{endpoint}/{policy_id}"
            gh_api("DELETE", policy_ep, check=True)

    # Add policies that are missing
    for name in expected:
        if name not in existing:
            print(f"  Adding branch policy: {name}")
            gh_api(
                "POST",
                f"repos/{repo}/environments/bedrock/deployment-branch-policies",
                {"name": name, "type": "branch"},
                check=True,
            )


def build_result(
    repo: str,
    env: dict | None,
    mismatches: list[tuple[str, str, str]],
) -> dict:
    """Build a structured result dict for JSON output."""
    exists = env is not None
    actual_policy = env.get("deployment_branch_policy", {}) if env else None
    actual_branches = get_branch_policies(repo) if exists else None

    result: dict = {
        "repo": repo,
        "environment": "bedrock",
        "exists": exists,
        "valid": exists and len(mismatches) == 0,
        "expected": {
            "deployment_branch_policy": EXPECTED_DEPLOYMENT_BRANCH_POLICY,
            "branch_policies": EXPECTED_BRANCH_NAMES,
        },
    }
    if exists:
        result["actual"] = {
            "deployment_branch_policy": actual_policy,
            "branch_policies": actual_branches,
        }
    if mismatches:
        result["mismatches"] = [
            {"setting": s, "expected": e, "actual": a} for s, e, a in mismatches
        ]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Setup bedrock GitHub environment for Claude Code workflows.",
    )
    parser.add_argument("repo", help="org/repo (e.g. pytorch/tutorials)")
    parser.add_argument("--force", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true", help="Output result as JSON")
    args = parser.parse_args()

    repo = args.repo
    org = repo.split("/")[0]

    if org not in ALLOWED_ORGS:
        if args.json:
            json.dump(
                {"error": f"org must be one of {ALLOWED_ORGS}, got '{org}'"},
                sys.stdout,
            )
            print()
        else:
            print(f"Error: org must be one of {ALLOWED_ORGS}, got '{org}'")
        sys.exit(1)

    env = get_environment(repo)

    if env is not None:
        mismatches = validate_environment(repo)

        if args.json and not args.force:
            json.dump(build_result(repo, env, mismatches), sys.stdout, indent=2)
            print()
            sys.exit(1 if mismatches else 0)

        if not args.json:
            print(
                f"'bedrock' environment already exists on {repo}."
                " Validating settings..."
            )

        if mismatches:
            if not args.json:
                print(
                    "\nMismatch: existing 'bedrock' environment settings"
                    " differ from expected:\n"
                )
                print(f"  {'SETTING':<50} {'EXPECTED':<20} {'ACTUAL':<20}")
                print(f"  {'-------':<50} {'--------':<20} {'------':<20}")
                for setting, expected, actual in mismatches:
                    print(f"  {setting:<50} {expected:<20} {actual:<20}")
                print()

            if args.force:
                if not args.json:
                    print("--force specified. Overwriting remote settings...")
            else:
                print(
                    "To overwrite remote settings with expected values,"
                    " re-run with --force:"
                )
                print(f"  {sys.argv[0]} --force {repo}")
                sys.exit(1)
        else:
            if not args.json:
                print("Settings match. Nothing to do.")
            sys.exit(0)

    create_environment(repo)

    if args.json:
        result = build_result(repo, get_environment(repo), [])
        result["action"] = "created"
        json.dump(result, sys.stdout, indent=2)
        print()
    else:
        print(f"""
Remaining manual steps:
  1. Add 'repo:{repo}:environment:bedrock' to the OIDC subject condition
     on the IAM role for fbossci in configerator.
  2. Install the Claude GitHub App on the repo.
  3. Add CLAUDE.md and .github/workflows/claude-code.yml to the repo.""")


if __name__ == "__main__":
    main()
