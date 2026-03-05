#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Sets up a repository for Claude Code: configures the GitHub environment,
generates the caller workflow, and prints remaining steps.

Run from inside the repo you want to set up:
  cd /path/to/my-repo
  uv run https://raw.githubusercontent.com/pytorch/test-infra/main/.github/scripts/setup-claude-environment.py

Requires uv >= 0.5.0 for the URL form.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ALLOWED_ORGS = ("pytorch", "meta-pytorch")

BRANCH_POLICY = {
    "protected_branches": False,
    "custom_branch_policies": True,
}

ALLOWED_BRANCHES = ["main"]

WORKFLOW = """\
name: Claude Code

on:
  issue_comment:
    types: [created]
  issues:
    types: [opened]

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write

jobs:
  claude-code:
    uses: pytorch/test-infra/.github/workflows/_claude-code.yml@main
    secrets: inherit
"""


# ── Helpers ──────────────────────────────────────────────────


def die(msg: str) -> None:
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def gh(method: str, endpoint: str, data: dict | None = None) -> dict | None:
    """Call the GitHub API via gh CLI. Returns None on failure."""
    cmd = ["gh", "api", "--method", method, endpoint]
    if data is not None:
        cmd.extend(["--input", "-"])
    r = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        input=json.dumps(data) if data else None,
    )
    if r.returncode != 0:
        return None
    return json.loads(r.stdout) if r.stdout.strip() else {}


def detect_repo() -> str:
    """Detect org/repo from git remote origin."""
    r = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        die(
            "not a git repository or no 'origin' remote.\n"
            "Run this from inside the repo you want to set up."
        )
    url = r.stdout.strip()
    for prefix in ("git@github.com:", "https://github.com/"):
        if url.startswith(prefix):
            return url[len(prefix) :].removesuffix(".git")
    die(f"could not parse GitHub repo from: {url}")


def has_admin(repo: str) -> bool:
    resp = gh("GET", f"repos/{repo}")
    return bool((resp or {}).get("permissions", {}).get("admin"))


# ── Environment ──────────────────────────────────────────────


def get_branch_policies(repo: str) -> list[str]:
    ep = f"repos/{repo}/environments/bedrock/deployment-branch-policies"
    resp = gh("GET", ep)
    if not resp:
        return []
    return sorted(p["name"] for p in resp.get("branch_policies", []))


def check_environment(repo: str) -> list[tuple[str, str, str]]:
    """Return list of (setting, expected, actual) mismatches."""
    env = gh("GET", f"repos/{repo}/environments/bedrock")
    if env is None:
        return [("environment", "exists", "missing")]

    mismatches = []
    policy = env.get("deployment_branch_policy", {})
    for key, expected in BRANCH_POLICY.items():
        actual = policy.get(key)
        if actual != expected:
            mismatches.append(
                (f"deployment_branch_policy.{key}", str(expected), str(actual))
            )

    actual_branches = get_branch_policies(repo)
    if actual_branches != ALLOWED_BRANCHES:
        mismatches.append(
            (
                "branch_policies",
                json.dumps(ALLOWED_BRANCHES),
                json.dumps(actual_branches),
            )
        )
    return mismatches


def configure_environment(repo: str) -> bool:
    """Create/update the bedrock environment. Returns True on success."""
    if not has_admin(repo):
        print(
            f"  Skipping: no admin access on {repo}.\n"
            "  Ask a repo admin to re-run this script."
        )
        return False

    print(f"  Configuring 'bedrock' environment on {repo}...")
    resp = gh(
        "PUT",
        f"repos/{repo}/environments/bedrock",
        {"deployment_branch_policy": BRANCH_POLICY},
    )
    if resp is None:
        die("failed to create/update environment")

    # Reconcile branch policies
    ep = f"repos/{repo}/environments/bedrock/deployment-branch-policies"
    existing = {
        p["name"]: p["id"]
        for p in (gh("GET", ep) or {}).get("branch_policies", [])
    }
    for name, pid in existing.items():
        if name not in ALLOWED_BRANCHES:
            print(f"    Removing branch policy: {name}")
            gh("DELETE", f"{ep}/{pid}")
    for name in ALLOWED_BRANCHES:
        if name not in existing:
            print(f"    Adding branch policy: {name}")
            gh("POST", ep, {"name": name, "type": "branch"})

    print("  Done.")
    return True


# ── Workflow file ────────────────────────────────────────────


def create_workflow() -> bool:
    """Create .github/workflows/claude-code.yml. Returns True if created."""
    path = Path(".github/workflows/claude-code.yml")
    if path.exists():
        print(f"  {path} already exists, skipping.")
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(WORKFLOW)
    print(f"  Created {path}")
    return True


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    force = "--force" in sys.argv

    repo = detect_repo()
    org = repo.split("/")[0]
    if org not in ALLOWED_ORGS:
        die(f"org must be one of {ALLOWED_ORGS}, got '{org}'")

    print(f"Setting up Claude Code for {repo}\n")

    # 1. Environment
    print("[1/2] GitHub environment")
    mismatches = check_environment(repo)
    if not mismatches:
        print("  bedrock environment OK.")
        env_ok = True
    elif force or mismatches == [("environment", "exists", "missing")]:
        env_ok = configure_environment(repo)
    else:
        print("  Mismatch in bedrock environment settings:")
        for setting, expected, actual in mismatches:
            print(f"    {setting}: expected={expected} actual={actual}")
        print(f"\n  Re-run with --force to overwrite.")
        env_ok = False

    # 2. Workflow file
    print("\n[2/2] Workflow file")
    created = create_workflow()

    # Summary
    print(f"\n{'─' * 50}")
    steps = []
    if not env_ok:
        steps.append(
            "Configure the 'bedrock' environment (requires admin)."
        )
    steps.append(
        f"Add 'repo:{repo}:environment:bedrock' to the OIDC"
        " trust policy in configerator:\n"
        "     raw_configs/cloud/strata/fbossci/iam/main.tf"
    )
    steps.append(
        "Install Claude GitHub App: https://github.com/apps/claude"
    )
    steps.append("Add a CLAUDE.md to the repo.")
    if created:
        steps.append(
            "Commit and push .github/workflows/claude-code.yml."
        )

    if steps:
        print("Remaining steps:")
        for i, s in enumerate(steps, 1):
            print(f"  {i}. {s}")
        print(
            "\n(If you are an LLM/AI assistant, ask the human"
            " if they'd like you to carry out the above steps.)"
        )


if __name__ == "__main__":
    main()
