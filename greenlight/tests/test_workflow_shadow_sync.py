"""Pins the shadow wiring in the reviewer workflow, which nothing at run time holds together.

``greenlight verdict`` takes ``--shadow`` as a bare flag, so leaving it off means ``shadow=False``
and nothing fails. What that costs depends on the call site, and only one of the four is defended
in Python: the terminal verdict recomputes ``request.shadow or cohort.is_shadow(author)``, so a
forgotten flag there is caught by the OR. The three marker calls take ``request.shadow`` verbatim
-- deliberately, since deriving a marker fail-closed would hide a trusted author's in-flight
review from a reader that filters shadow out. A marker written without the flag therefore records
a shadow PR as an ordinary one, and Dr. CI renders it: greenlight state shown on a PR whose
evaluation carries no authority. The approval itself is not at stake, because the verdict path
withholds and dismisses off its own derivation rather than off the flag.

The four call sites in ``.github/workflows/greenlight-pr-review.yml`` are separate shell bodies
with nothing linking them, and one added later inherits the same silent default. These tests are
that link -- they fail when a verdict call or a per-job validation step stops matching the
others.

The workflow's own end of the wire is pinned against ``greenlight.dispatch``: the literals its
validator branches on are probed out of ``dispatch_review`` rather than restated here, because a
validator that accepts spellings the dispatcher never sends aborts every real run.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

from greenlight import cli, dispatch

ROOT = Path(__file__).resolve().parents[2]

_WORKFLOW = ".github/workflows/greenlight-pr-review.yml"
_DISPATCH = "greenlight/src/greenlight/dispatch.py"

assert (ROOT / _WORKFLOW).is_file()

_VERDICT_CALL = "greenlight verdict"
_SHADOW_FLAG = "SHADOW_FLAG"
# `--shadow` is a bare flag, so the false case must pass NO argument, and only the `:+` form
# expands to nothing. `--shadow "$SHADOW_FLAG"` passes an empty option-argument and a bare
# `"$SHADOW_FLAG"` passes an empty positional; both reach the CLI and both fail there.
_SHADOW_EXPANSION = f'${{{_SHADOW_FLAG}:+"${_SHADOW_FLAG}"}}'
_SHADOW_INPUT = "${{ github.event.inputs.shadow }}"

_CASE_FALLBACK_ARM = "*"
_CASE_RE = re.compile(r'case\s+"\$SHADOW"\s+in\b(.*?)\besac\b', re.DOTALL)
_CASE_ARM_RE = re.compile(r"^[^\S\n]*([^)\s]+)\)", re.MULTILINE)
_NONZERO_EXIT_RE = re.compile(r"\bexit\s+[1-9]\d*\b")
_SHADOW_ASSIGNMENT_RE = re.compile(rf'{_SHADOW_FLAG}=([^"]*)"')

# announce_start writes the in-flight marker; record writes the terminal verdict and both the
# cancelled and failed markers. The review job runs the model and writes no state row at all.
_ROW_WRITING_JOBS = ("announce_start", "record")
_VERDICT_CALL_SITES = 4

_DOC: dict[Any, Any] = yaml.safe_load((ROOT / _WORKFLOW).read_text())
_JOBS: dict[str, Any] = _DOC["jobs"]


def _drift(detail: str) -> str:
    return f"{_WORKFLOW} drifted from the shadow contract: {detail}"


def _triggers() -> dict[str, Any]:
    # PyYAML resolves an unquoted `on:` key to the boolean True under YAML 1.1, so the trigger
    # block is not reachable by the name it is written under.
    block = _DOC.get("on", _DOC.get(True))
    assert isinstance(block, dict), f"{_WORKFLOW} has no `on:` block"
    return block


def _steps(job: str) -> list[dict[str, Any]]:
    steps = _JOBS[job]["steps"]
    assert isinstance(steps, list)
    return steps


def _field(step: dict[str, Any], key: str) -> str:
    value = step.get(key, "")
    assert isinstance(value, str), f"{_WORKFLOW}: `{key}` is not a string on step {step.get('name')!r}: {value!r}"
    return value


def _invocations(snippet: str) -> list[tuple[str, dict[str, Any]]]:
    """Every ``(job, step)`` in the workflow whose ``run:`` body invokes ``snippet``."""
    return [(job, step) for job in _JOBS for step in _steps(job) if snippet in _field(step, "run")]


def _label(job: str, step: dict[str, Any]) -> str:
    return f"{job} / {_field(step, 'name')}"


def _writes_shadow_flag(step: dict[str, Any]) -> bool:
    run = _field(step, "run")
    return f"{_SHADOW_FLAG}=" in run and "$GITHUB_ENV" in run


def _validator(job: str) -> dict[str, Any]:
    validators = [step for step in _steps(job) if _writes_shadow_flag(step)]
    assert len(validators) == 1, _drift(
        f"job {job} has {len(validators)} steps writing {_SHADOW_FLAG} to $GITHUB_ENV, expected exactly one."
    )
    return validators[0]


def _case_arms(job: str) -> dict[str, str]:
    """The validator's ``case "$SHADOW"`` arms, mapped from pattern to the body it guards."""
    match = _CASE_RE.search(_field(_validator(job), "run"))
    assert match is not None, _drift(f'job {job} validates $SHADOW without a `case "$SHADOW" in ... esac`.')
    body = match.group(1)
    hits = list(_CASE_ARM_RE.finditer(body))
    assert hits, _drift(f"job {job} has a `case` on $SHADOW with no arms.")
    arms = {
        hit.group(1): body[hit.end() : hits[index + 1].start() if index + 1 < len(hits) else len(body)]
        for index, hit in enumerate(hits)
    }
    patterns = [hit.group(1) for hit in hits]
    assert len(arms) == len(hits), _drift(f"job {job} repeats a `case` pattern on $SHADOW: {patterns}")
    return arms


class _CapturingDispatchClient:
    """Minimal ``workflow_dispatch`` sink: records the ``inputs`` payload and dispatches nothing."""

    def __init__(self) -> None:
        self.inputs: dict[str, str] = {}

    def get_repo(self, full_name_or_id: str) -> _CapturingDispatchClient:
        return self

    def get_workflow(self, id_or_file_name: str) -> _CapturingDispatchClient:
        return self

    def create_dispatch(self, ref: str, inputs: dict[str, str], throw: bool) -> bool:
        self.inputs = inputs
        return True


def _dispatched_shadow_literals() -> dict[bool, str]:
    """The ``shadow`` input literal ``dispatch_review`` puts on the wire, per cohort."""
    literals = {}
    for shadow in (True, False):
        sink = _CapturingDispatchClient()
        dispatch.dispatch_review(sink, 1, "b" * 40, "a" * 64, shadow=shadow)
        literals[shadow] = sink.inputs["shadow"]
    assert len(set(literals.values())) == 2, f"{_DISPATCH} sends one literal for both cohorts: {literals}"
    return literals


def _parsed_shadow(assigned: str) -> bool:
    """What ``greenlight verdict`` makes of a ``SHADOW_FLAG`` holding ``assigned``."""
    argv = ["verdict", "--pr", "1", "--head-sha", "b" * 40]
    # `${SHADOW_FLAG:+"$SHADOW_FLAG"}` contributes one argument when the value is non-empty and none
    # at all when it is empty; reproduce exactly that rather than the shape of the assignment.
    if assigned:
        argv.append(assigned)
    try:
        return bool(cli.build_parser().parse_args(argv).shadow)
    except SystemExit as exc:
        raise AssertionError(_drift(f"the verdict CLI rejects `{assigned}` outright.")) from exc


def test_every_verdict_call_site_passes_shadow() -> None:
    unwired = sorted(
        _label(job, step) for job, step in _invocations(_VERDICT_CALL) if _SHADOW_EXPANSION not in _field(step, "run")
    )
    assert not unwired, _drift(
        f"these `{_VERDICT_CALL}` steps do not pass shadow as `{_SHADOW_EXPANSION}`: {unwired}. Merely "
        f"naming {_SHADOW_FLAG} is not enough -- the flag is a bare one, so the false case must expand to "
        f"no argument at all, and any other form either passes an empty argument the CLI rejects or "
        f"records the row as non-shadow, which Dr. CI renders and the merge gate honours."
    )


def test_verdict_call_site_count_is_pinned() -> None:
    found = sorted(_label(job, step) for job, step in _invocations(_VERDICT_CALL))
    assert len(found) == _VERDICT_CALL_SITES, _drift(
        f"expected {_VERDICT_CALL_SITES} `{_VERDICT_CALL}` steps, found {len(found)}: {found}. "
        f"Wire the new one for shadow and raise the pin, or drop the stale one and lower it."
    )


@pytest.mark.parametrize("job", _ROW_WRITING_JOBS)
def test_row_writing_job_reads_the_shadow_input(job: str) -> None:
    env = _JOBS[job].get("env", {})
    assert env.get("SHADOW") == _SHADOW_INPUT, _drift(
        f"job {job} sets SHADOW to {env.get('SHADOW')!r} rather than {_SHADOW_INPUT}. Reading the input "
        f"through a job-level env var is what keeps the raw expression out of every `run:` body."
    )


@pytest.mark.parametrize("job", _ROW_WRITING_JOBS)
def test_row_writing_job_validates_shadow_before_every_verdict_call(job: str) -> None:
    steps = _steps(job)
    validators = [i for i, step in enumerate(steps) if _writes_shadow_flag(step)]
    callers = [i for i, step in enumerate(steps) if _VERDICT_CALL in _field(step, "run")]
    assert validators, _drift(f"job {job} has no step writing {_SHADOW_FLAG} to $GITHUB_ENV.")
    assert callers, _drift(f"job {job} makes no `{_VERDICT_CALL}` call, so its shadow wiring is dead.")
    assert max(validators) < min(callers), _drift(
        f"job {job} writes {_SHADOW_FLAG} at step index {max(validators)} but calls verdict at "
        f"{min(callers)}. $GITHUB_ENV reaches only SUBSEQUENT steps, so a validation step that does not "
        f"precede every call leaves {_SHADOW_FLAG} unset and the `:+` guard expands to nothing -- the "
        f"call then reads as non-shadow with nothing failing."
    )


@pytest.mark.parametrize("job", _ROW_WRITING_JOBS)
def test_shadow_validation_step_is_unconditional(job: str) -> None:
    step = _validator(job)
    assert "if" not in step, _drift(
        f"job {job}'s {_field(step, 'name')!r} step carries `if: {step['if']}`. Preceding every verdict "
        f"call is only half the contract: a skipped validator leaves {_SHADOW_FLAG} unset, and "
        f"`{_SHADOW_EXPANSION}` then expands to nothing WITHOUT tripping `set -u` -- so every call in the "
        f"job silently records a non-shadow row instead of failing."
    )


@pytest.mark.parametrize("job", _ROW_WRITING_JOBS)
def test_shadow_case_arms_match_what_dispatch_sends(job: str) -> None:
    matched = set(_case_arms(job)) - {_CASE_FALLBACK_ARM}
    dispatched = set(_dispatched_shadow_literals().values())
    assert matched == dispatched, _drift(
        f"job {job} branches on {sorted(matched)} but {_DISPATCH} sends {sorted(dispatched)}. The two are "
        f"one contract with nothing between them: rename an arm and every arm still parses, every test "
        f"that only counts them still passes, and every real dispatch falls through to the abort arm."
    )


@pytest.mark.parametrize("job", _ROW_WRITING_JOBS)
def test_shadow_case_arms_set_the_flag_their_cohort_needs(job: str) -> None:
    arms = _case_arms(job)
    for shadow, literal in _dispatched_shadow_literals().items():
        assert literal in arms, _drift(f"job {job} has no `{literal})` arm; it branches on {sorted(arms)}.")
        assigned = _SHADOW_ASSIGNMENT_RE.search(arms[literal])
        assert assigned is not None, _drift(
            f"job {job}'s `{literal})` arm assigns no {_SHADOW_FLAG}: {arms[literal]!r}"
        )
        parsed = _parsed_shadow(assigned.group(1))
        assert parsed is shadow, _drift(
            f"job {job} maps the dispatcher's `{literal}` (shadow={shadow}) to "
            f"`{_SHADOW_FLAG}={assigned.group(1)}`, which `{_VERDICT_CALL}` parses as shadow={parsed}. "
            f"Swapping the two arm bodies leaves every arm parsing, every pattern matching and every "
            f"count intact -- while approving exactly the PRs shadow mode exists to hold back."
        )


@pytest.mark.parametrize("job", _ROW_WRITING_JOBS)
def test_shadow_case_fallback_arm_aborts(job: str) -> None:
    arms = _case_arms(job)
    assert _CASE_FALLBACK_ARM in arms, _drift(
        f"job {job} has no `{_CASE_FALLBACK_ARM})` arm on $SHADOW: {sorted(arms)}."
    )
    assert _NONZERO_EXIT_RE.search(arms[_CASE_FALLBACK_ARM]) is not None, _drift(
        f"job {job}'s `{_CASE_FALLBACK_ARM})` arm does not exit non-zero: {arms[_CASE_FALLBACK_ARM]!r}. An "
        f"unrecognized value must abort, because falling through leaves {_SHADOW_FLAG} unset -- which reads "
        f"as visible-and-approvable, the one wrong answer for a value nobody could parse."
    )


def test_shadow_input_defaults_to_not_shadow() -> None:
    declared = _triggers()["workflow_dispatch"]["inputs"]["shadow"]
    assert declared.get("default") is False, _drift(
        f"the `shadow` input declares default {declared.get('default')!r}. A dispatcher that omits the "
        f"input gets this value, so `true` silently shadows every review, and a boolean input with no "
        f"default makes the REST API reject the dispatch outright."
    )
