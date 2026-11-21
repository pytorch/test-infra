"""Pins the App tokens ``greenlight-review.yml`` mints to the ones the Lambda mints (``app_tokens``).

The manual scan mints two tokens, as ``app_tokens.AppTokens`` does: a ``pytorch/test-infra`` token for
the repos config and the dispatch, the only one with ``actions``, and a repo token for the configured
repos with no ``actions``. Nothing at run time ties the workflow's ``permission-*`` inputs to the
Python permission sets, so these tests do.

A recheck's repo token covers the one repo ``greenlight target`` validated, and the reviewer workflow
(``greenlight-pr-review.yml``) scopes each of its mints to that job's validated target as well: an
empty ``repositories`` with ``owner`` set would mint for every repo of the installation.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from greenlight import app_tokens, repo_config
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


def test_the_repos_step_lists_the_validated_repo_for_a_recheck_and_the_configured_repos_otherwise():
    assert _STEPS.index(_step(_REPOS_STEP)) < _STEPS.index(_step(_REPO_STEP)), _drift(
        "the repos step must run before the repo mint"
    )
    step = _step(_REPOS_STEP)
    run = step["run"]
    assert step["env"] == {"IN_PR": "${{ inputs.pr }}", "IN_REPO": "${{ inputs.repo }}"}
    assert 'target=$(mise exec -- uv run greenlight target --repo "$IN_REPO" --pr "$IN_PR")' in run
    assert "names=$(sed -n 's/^name=//p' <<<\"$target\")" in run
    assert "repo=$(sed -n 's/^repo=//p' <<<\"$target\")" in run
    assert "pr=$(sed -n 's/^pr=//p' <<<\"$target\")" in run
    assert "app_tokens.repo_token_names(repo_config.load_local())" in run
    for name in ("names", "repo", "pr"):
        assert f'echo "{name}=${name}"' in run
    assert '} >> "$GITHUB_OUTPUT"' in run


def test_a_repo_without_a_pr_fails_the_repos_step():
    run = _step(_REPOS_STEP)["run"]
    without_pr = run.split('elif [ -n "$IN_REPO" ]; then', 1)[1].split("else", 1)[0]
    assert "exit 1" in without_pr


def test_the_repo_input_defaults_to_the_primary():
    inputs = yaml.safe_load((ROOT / _WORKFLOW).read_text())[True]["workflow_dispatch"]["inputs"]
    assert inputs["repo"] == {
        "description": inputs["repo"]["description"],
        "required": False,
        "default": "",
        "type": "string",
    }


def test_repo_token_names_lists_the_served_and_safety_only_repos_of_the_real_config():
    config = repo_config.load_local()
    entries = (*config.served, *(entry for entry, _reason in config.safety_only))

    names = app_tokens.repo_token_names(config).split(",")

    assert sorted(names) == sorted(entry.repo.partition("/")[2] for entry in entries)
    assert names[0] == TARGET_REPO.partition("/")[2]


def test_the_scan_step_reads_both_tokens_and_runs_every_repo_without_a_pr():
    [scan] = [step for step in _STEPS if "greenlight review" in str(step.get("run", ""))]
    env = scan["env"]
    assert env["PYTORCH_GREENLIGHT_GITHUB_TOKEN"] == "${{ steps.repo-token.outputs.token }}"
    assert env["PYTORCH_GREENLIGHT_DISPATCH_TOKEN"] == "${{ steps.dispatch-token.outputs.token }}"
    assert env["BOT_LOGIN"] == "${{ steps.repo-token.outputs.app-slug }}[bot]"
    assert env["PR"] == "${{ steps.repos.outputs.pr }}"
    assert env["REPO"] == "${{ steps.repos.outputs.repo }}"
    assert "IN_PR" not in env
    assert 'if [ -n "$PR" ]; then args+=(--repo "$REPO" --pr "$PR"); else args+=(--all-repos); fi' in scan["run"]


_REVIEWER = ".github/workflows/greenlight-pr-review.yml"
_REVIEWER_JOBS: dict[str, Any] = yaml.safe_load((ROOT / _REVIEWER).read_text())["jobs"]
_TARGET_NAME = "${{ steps.target.outputs.name }}"


def _reviewer_mints() -> dict[str, tuple[int, dict[str, Any]]]:
    found: dict[str, tuple[int, dict[str, Any]]] = {}
    for job, spec in _REVIEWER_JOBS.items():
        for index, step in enumerate(spec["steps"]):
            if str(step.get("uses", "")).startswith(_TOKEN_ACTION):
                assert job not in found, f"{_REVIEWER}: job {job} mints more than one App token"
                found[job] = (index, step)
    return found


def test_the_reviewer_mints_only_in_the_two_row_writing_jobs():
    assert sorted(_reviewer_mints()) == ["announce_start", "record"]


def test_every_reviewer_mint_is_scoped_to_its_jobs_validated_target():
    for job, (index, step) in _reviewer_mints().items():
        assert (step["with"]["owner"], step["with"]["repositories"]) == (_OWNER, _TARGET_NAME), job
        target = [i for i, s in enumerate(_REVIEWER_JOBS[job]["steps"]) if s.get("id") == "target"]
        assert target, f"{_REVIEWER}: job {job} has no target step"
        assert target[0] < index, f"{_REVIEWER}: job {job} mints before validating its target"
        assert "permission-actions" not in step["with"]


def test_the_record_mint_never_runs_without_a_validated_target():
    _index, step = _reviewer_mints()["record"]
    assert step["if"] == "always() && steps.target.outcome == 'success'"
    assert step["continue-on-error"] is True


def test_the_announce_mint_keeps_the_implicit_success_and_continues_on_error():
    _index, step = _reviewer_mints()["announce_start"]
    assert "if" not in step
    assert step["continue-on-error"] is True
