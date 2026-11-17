"""Pins the App tokens ``greenlight-review.yml`` mints to the ones the Lambda mints (``app_tokens``).

The manual scan mints two tokens, as ``app_tokens.AppTokens`` does: a ``pytorch/test-infra`` token for
the dispatch, the only one with ``actions``, and a repo token for the one repo it scans, with no
``actions``. Nothing at run time ties the workflow's ``permission-*`` inputs to the Python permission
sets, so these tests do.

The reviewer workflow (``greenlight-pr-review.yml``) scopes each of its mints to the repo its job's
``greenlight target`` step validated: an empty ``repositories`` with ``owner`` set would mint for every
repo of the installation.
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
_NAME_STEP = "repo"
_DISPATCH_STEP = "dispatch-token"
_REPO_STEP = "repo-token"
_REPO_NAME = "${{ steps.repo.outputs.name }}"

_DOCUMENT: dict[Any, Any] = yaml.safe_load((ROOT / _WORKFLOW).read_text())
_STEPS: list[dict[str, Any]] = _DOCUMENT["jobs"]["scan"]["steps"]


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


def test_the_repo_token_covers_the_one_repo_the_workflow_names_with_the_repo_permissions():
    inputs = _step(_REPO_STEP)["with"]
    assert (inputs.get("owner"), inputs.get("repositories")) == (_OWNER, _REPO_NAME), _drift(
        "the repo token must name the one repo the `repo` step computes, never the whole installation"
    )
    assert _permissions(_step(_REPO_STEP)) == _inputs(app_tokens.REPO_TOKEN_PERMISSIONS), _drift(
        "the repo token's permissions must equal REPO_TOKEN_PERMISSIONS"
    )


def test_no_mint_but_the_dispatch_token_grants_actions():
    granting = [step.get("id") for step in _mints() if "permission-actions" in step["with"]]
    assert granting == [_DISPATCH_STEP], _drift(f"only the dispatch token may grant actions, found {granting}")
    assert "actions" not in app_tokens.REPO_TOKEN_PERMISSIONS
    assert "actions" not in app_tokens.LISTING_TOKEN_PERMISSIONS


def test_the_repo_input_defaults_to_the_primary():
    # PyYAML reads the workflow's bare `on` key as the YAML 1.1 boolean True.
    repo = _DOCUMENT[True]["workflow_dispatch"]["inputs"]["repo"]
    assert (repo.get("default"), repo.get("type")) == (TARGET_REPO, "string")


def test_the_repo_step_names_the_repo_input_inside_pytorch_and_runs_before_the_repo_mint():
    step = _step(_NAME_STEP)
    assert _STEPS.index(step) < _STEPS.index(_step(_REPO_STEP)), _drift("the repo step must run before the repo mint")
    assert step["env"] == {"IN_REPO": "${{ inputs.repo }}"}
    run = step["run"]
    assert f"^{_OWNER}/([A-Za-z0-9_.-]{{1,100}})$" in run
    assert '"name=$name" >> "$GITHUB_OUTPUT"' in run
    assert "${{" not in run, "inputs reach the script through env vars only"


def test_the_scan_step_reads_both_tokens_and_scans_the_one_repo():
    [scan] = [step for step in _STEPS if "greenlight review" in str(step.get("run", ""))]
    env = scan["env"]
    assert env["PYTORCH_GREENLIGHT_GITHUB_TOKEN"] == "${{ steps.repo-token.outputs.token }}"
    assert env["PYTORCH_GREENLIGHT_DISPATCH_TOKEN"] == "${{ steps.dispatch-token.outputs.token }}"
    assert env["BOT_LOGIN"] == "${{ steps.repo-token.outputs.app-slug }}[bot]"
    assert env["IN_REPO"] == "${{ inputs.repo }}"
    run = scan["run"]
    assert 'args=(--repo "$IN_REPO")' in run
    assert 'if [ -n "$IN_PR" ]; then args+=(--pr "$IN_PR"); fi' in run
    assert "${{" not in run, "inputs reach the script through env vars only"


def test_no_step_runs_every_repo():
    assert "--all-repos" not in (ROOT / _WORKFLOW).read_text()


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


def test_the_announce_mint_reads_the_config_and_keeps_the_implicit_success():
    _index, step = _reviewer_mints()["announce_start"]
    assert "if" not in step
    assert step["continue-on-error"] is True
    assert step["with"]["permission-contents"] == "read"
