"""Pins ``.github/workflows/greenlight-gate.yml``, the workflow an organization ruleset requires before merging.

A ruleset runs it at a pinned commit of pytorch/test-infra whatever its triggers say, so every way it could end
green without running ``greenlight gate-check`` on the event's PR and head is pinned shut here: a skip condition,
continue-on-error, a cancelling concurrency group, a local action outside code ownership, a checkout of something
other than the gate's own commit, or an expression spliced into a shell script.
"""

from __future__ import annotations

import re
import shlex
from pathlib import Path
from typing import Any

import pytest
import yaml

from greenlight import constants

ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = ROOT / constants.GATE_WORKFLOW_PATH

_DOC: dict[Any, Any] = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))
_JOBS: dict[str, Any] = _DOC["jobs"]
_STEPS: list[dict[str, Any]] = _JOBS["gate"]["steps"]

_CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"
_SETUP_PYTHON = "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065"
_SETUP_UV = "astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b"


def _walk(node: Any) -> list[tuple[Any, Any]]:
    """Every (key, value) pair of every mapping in ``node``, at any depth."""
    pairs: list[tuple[Any, Any]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            pairs.append((key, value))
            pairs.extend(_walk(value))
    elif isinstance(node, list):
        for item in node:
            pairs.extend(_walk(item))
    return pairs


def _step(predicate: str) -> dict[str, Any]:
    found = [step for step in _STEPS if predicate in str(step.get("uses", "")) + str(step.get("id", ""))]
    assert len(found) == 1, predicate
    return found[0]


def _gate_step() -> dict[str, Any]:
    found = [step for step in _STEPS if "greenlight gate-check" in step.get("run", "")]
    assert len(found) == 1
    return found[0]


def test_the_workflow_path_constant_names_this_file():
    assert _WORKFLOW.is_file()
    assert constants.GATE_WORKFLOW_PATH == ".github/workflows/greenlight-gate.yml"


def test_name_and_triggers():
    assert _DOC["name"] == "GreenLight gate"
    on = _DOC.get("on", _DOC.get(True))
    assert on == {"pull_request": {"paths": [constants.GATE_WORKFLOW_PATH, "greenlight/**"]}}


@pytest.mark.parametrize("key", ["workflow_call", "concurrency", "if", "continue-on-error"])
def test_no_key_anywhere(key: str) -> None:
    assert key not in [k for k, _v in _walk(_DOC)]
    assert re.search(rf"^\s*{re.escape(key)}\s*:", _WORKFLOW.read_text(encoding="utf-8"), re.MULTILINE) is None


def test_one_job_named_gate():
    assert list(_JOBS) == ["gate"]
    job = _JOBS["gate"]
    assert job["name"] == "gate"
    assert job["runs-on"] == "ubuntu-latest"
    assert job["timeout-minutes"] == 350
    assert job["timeout-minutes"] > constants.GATE_TIMEOUT_MINUTES_MAX
    assert job["permissions"] == {"contents": "read", "pull-requests": "read"}
    assert "permissions" not in _DOC


def test_step_order():
    uses = [step.get("uses", "").split("@")[0] for step in _STEPS]
    assert uses == ["", "actions/checkout", "actions/setup-python", "astral-sh/setup-uv", ""]
    assert _STEPS[0]["id"] == "self"
    assert _STEPS[-1] is _gate_step()


def test_self_check_reads_the_job_context_and_pins_repository_path_and_sha():
    step = _step("self")
    assert step["env"] == {"JOB_CONTEXT": "${{ toJSON(job) }}"}
    script = step["run"]
    assert script.lstrip().startswith("set -euo pipefail")
    for field in ("workflow_repository", "workflow_file_path", "workflow_sha"):
        assert f".{field}" in script
    assert '"$repository" != "pytorch/test-infra"' in script
    assert f'"$file_path" != "{constants.GATE_WORKFLOW_PATH}"' in script
    assert "=~ ^[0-9a-f]{40}$ ]]" in script
    assert script.count("exit 1") == 3
    assert 'echo "sha=$sha" >>"$GITHUB_OUTPUT"' in script
    assert constants.DISPATCH_REPO == "pytorch/test-infra"


def test_checkout_takes_greenlight_at_the_gate_commit():
    step = _step("actions/checkout")
    assert step["uses"] == _CHECKOUT
    assert step["with"] == {
        "repository": constants.DISPATCH_REPO,
        "ref": "${{ steps.self.outputs.sha }}",
        "persist-credentials": False,
        "fetch-depth": 1,
        "sparse-checkout": "greenlight",
    }


def test_python_and_uv_are_pinned():
    assert _step("actions/setup-python") == {
        "name": "Set up Python 3.13",
        "uses": _SETUP_PYTHON,
        "with": {"python-version": "3.13"},
    }
    uv = _step("astral-sh/setup-uv")
    assert uv["uses"] == _SETUP_UV
    assert uv["with"] == {"version": "0.11.14", "enable-cache": False}


def test_no_local_action():
    assert all(not str(step.get("uses", "")).startswith("./") for step in _STEPS)
    assert "uses: ./" not in _WORKFLOW.read_text(encoding="utf-8")


def test_no_expression_inside_any_run():
    runs = [value for key, value in _walk(_DOC) if key == "run"]
    assert len(runs) == 2
    assert all("${{" not in run for run in runs)


def test_gate_check_step_env_and_command():
    step = _gate_step()
    assert step["env"] == {
        "PYTORCH_GREENLIGHT_GITHUB_TOKEN": "${{ github.token }}",
        "GATE_REPO": "${{ github.repository }}",
        "GATE_PR": "${{ github.event.pull_request.number }}",
        "GATE_HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
    }
    command = shlex.split(step["run"].replace("\\\n", " "))
    assert command == [
        "uv",
        "run",
        "--project",
        "greenlight",
        "--frozen",
        "--no-dev",
        "greenlight",
        "gate-check",
        "--repo",
        "$GATE_REPO",
        "--pr",
        "$GATE_PR",
        "--head-sha",
        "$GATE_HEAD_SHA",
    ]


def test_tests_workflow_runs_on_gate_changes():
    tests = yaml.safe_load((ROOT / ".github/workflows/greenlight-tests.yml").read_text(encoding="utf-8"))
    on = tests.get("on", tests.get(True))
    assert constants.GATE_WORKFLOW_PATH in on["pull_request"]["paths"]
    assert constants.GATE_WORKFLOW_PATH in on["push"]["paths"]
