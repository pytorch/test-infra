"""Pins the App tokens ``greenlight-review.yml`` mints to the ones the Lambda mints (``app_tokens``).

The manual scan mints two tokens, as ``app_tokens.AppTokens`` does: a ``pytorch/test-infra`` token for
the repos config and the dispatch, the only one with ``actions``, and a repo token for the configured
repos with no ``actions``. Nothing at run time ties the workflow's ``permission-*`` inputs to the
Python permission sets, so these tests do.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from greenlight import app_tokens
from greenlight.constants import DISPATCH_REPO, TARGET_REPO

ROOT = Path(__file__).resolve().parents[2]

_WORKFLOW = ".github/workflows/greenlight-review.yml"
_TOKEN_ACTION = "actions/create-github-app-token@"
_OWNER = "pytorch"
_REPOS_STEP = "repos"
_DISPATCH_STEP = "dispatch-token"
_REPO_STEP = "repo-token"
_REPO_NAMES = "${{ steps.repos.outputs.names }}"

_STEPS: list[dict[str, Any]] = yaml.safe_load((ROOT / _WORKFLOW).read_text())["jobs"]["scan"]["steps"]


def _drift(detail: str) -> str:
    return f"{_WORKFLOW} drifted from greenlight/src/greenlight/app_tokens.py: {detail}"


def _inputs(permissions: dict[str, str]) -> dict[str, str]:
    """``permissions`` as ``actions/create-github-app-token`` inputs."""
    return {f"permission-{name.replace('_', '-')}": level for name, level in permissions.items()}


def _step(step_id: str) -> dict[str, Any]:
    found = [step for step in _STEPS if step.get("id") == step_id]
    assert len(found) == 1, _drift(f"expected exactly one step with id {step_id!r}, found {len(found)}")
    return found[0]


def _mints() -> list[dict[str, Any]]:
    return [step for step in _STEPS if str(step.get("uses", "")).startswith(_TOKEN_ACTION)]


def _permissions(step: dict[str, Any]) -> dict[str, str]:
    return {key: value for key, value in step["with"].items() if key.startswith("permission-")}


def test_the_workflow_mints_exactly_the_dispatch_and_repo_tokens_with_one_pinned_action():
    mints = _mints()
    assert [step.get("id") for step in mints] == [_DISPATCH_STEP, _REPO_STEP], _drift(
        "the scan job must mint exactly the dispatch token and the repo token"
    )
    assert len({step["uses"] for step in mints}) == 1, _drift("both mints must use the same pinned action SHA")


def test_the_dispatch_token_is_test_infra_only_with_the_dispatch_permissions():
    inputs = _step(_DISPATCH_STEP)["with"]
    assert (inputs.get("owner"), inputs.get("repositories")) == (_OWNER, DISPATCH_REPO.partition("/")[2]), _drift(
        "the dispatch token, the one token with actions: write, must name pytorch/test-infra alone"
    )
    assert _permissions(_step(_DISPATCH_STEP)) == _inputs(app_tokens.DISPATCH_TOKEN_PERMISSIONS), _drift(
        "the dispatch token's permissions must equal DISPATCH_TOKEN_PERMISSIONS"
    )


def test_the_repo_token_covers_the_listed_repos_with_the_repo_permissions():
    inputs = _step(_REPO_STEP)["with"]
    assert (inputs.get("owner"), inputs.get("repositories")) == (_OWNER, _REPO_NAMES), _drift(
        "the repo token must name the repos the `repos` step lists, never the whole installation"
    )
    assert _permissions(_step(_REPO_STEP)) == _inputs(app_tokens.REPO_TOKEN_PERMISSIONS), _drift(
        "the repo token's permissions must equal REPO_TOKEN_PERMISSIONS"
    )


def test_no_mint_but_the_dispatch_token_grants_actions():
    granting = [step.get("id") for step in _mints() if "permission-actions" in step["with"]]
    assert granting == [_DISPATCH_STEP], _drift(f"only the dispatch token may grant actions, found {granting}")
    assert "actions" not in app_tokens.REPO_TOKEN_PERMISSIONS
    assert "actions" not in app_tokens.LISTING_TOKEN_PERMISSIONS


def test_the_repos_step_lists_the_primary_for_a_recheck_and_the_configured_repos_otherwise():
    assert _STEPS.index(_step(_REPOS_STEP)) < _STEPS.index(_step(_REPO_STEP)), _drift(
        "the repos step must run before the repo mint"
    )
    run = _step(_REPOS_STEP)["run"]
    assert f"names={TARGET_REPO.partition('/')[2]}\n" in run
    assert "app_tokens.repo_token_names(repo_config.load_local())" in run
    assert '"names=$names" >> "$GITHUB_OUTPUT"' in run


def test_the_scan_step_reads_both_tokens_and_runs_every_repo_without_a_pr():
    [scan] = [step for step in _STEPS if "greenlight review" in str(step.get("run", ""))]
    env = scan["env"]
    assert env["PYTORCH_GREENLIGHT_GITHUB_TOKEN"] == "${{ steps.repo-token.outputs.token }}"
    assert env["PYTORCH_GREENLIGHT_DISPATCH_TOKEN"] == "${{ steps.dispatch-token.outputs.token }}"
    assert env["BOT_LOGIN"] == "${{ steps.repo-token.outputs.app-slug }}[bot]"
    assert 'if [ -n "$IN_PR" ]; then args+=(--pr "$IN_PR"); else args+=(--all-repos); fi' in scan["run"]
