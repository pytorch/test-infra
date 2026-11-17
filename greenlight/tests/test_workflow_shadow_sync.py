"""Pins the shadow wiring in the reviewer workflow, which nothing at run time holds together.

``greenlight verdict`` takes ``--shadow`` as a bare flag, so leaving it off means ``shadow=False``
and nothing fails. The terminal verdict ORs ``request.shadow`` with its own ``has_eligible_author``
check, but that catches a forgotten flag only for a PR that check finds ineligible: for an eligible
one, the flag alone withholds the approval. The three marker calls take
``request.shadow`` verbatim -- deliberately, since deriving a marker fail-closed would hide a trusted
author's in-flight review from a reader that filters shadow out. A marker written without the flag
therefore records a shadow PR as an ordinary one, and Dr. CI renders it: greenlight state shown on
a PR whose evaluation carries no authority. So every one of the four call sites is pinned.

The four call sites in ``.github/workflows/greenlight-pr-review.yml`` are separate shell bodies
with nothing linking them, and one added later inherits the same silent default. These tests are
that link -- they fail when a verdict call, a per-job validation step, or a Dr. CI poke guard
stops matching the others.

The workflow's own end of the wire is pinned against ``greenlight.dispatch``: the literals its
validator branches on are probed out of ``dispatch_review`` rather than restated here, because a
validator that accepts spellings the dispatcher never sends aborts every real run.

The App tokens those jobs mint are pinned as well. The terminal verdict's lookup needs the record
token to read the repo's merge rules and expand their teams; a token that writes pull requests gets
nothing beyond that, and no repository beyond the one ``greenlight target`` validated.

Every job validates the dispatch inputs with ``greenlight target`` before anything uses them (the
record job re-checking the review job's outputs offline when the review succeeded), and every
verdict call, Dr. CI poke, checkout and URL of the review uses only its outputs; the review job
stages the reviewed repo's own policy and, without a valid one or on a diff touching its
``.github/greenlight``, declines without running the model. Those are pinned too.

The size gate's file cap is pinned to ``constants.MAX_DIFF_FILES`` as well, and the gate's own shell
is run on diffs either side of it.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any, NamedTuple

import jsonschema
import pytest
import yaml

from greenlight import cli, constants, dispatch

ROOT = Path(__file__).resolve().parents[2]

_WORKFLOW = ".github/workflows/greenlight-pr-review.yml"
_DISPATCH = "greenlight/src/greenlight/dispatch.py"

assert (ROOT / _WORKFLOW).is_file()

_VERDICT_CALL = "greenlight verdict"
_POKE_CALL = "greenlight drci-poke"
_SHADOW_FLAG = "SHADOW_FLAG"
# `--shadow` is a bare flag, so the false case must pass NO argument, and only the `:+` form
# expands to nothing. `--shadow "$SHADOW_FLAG"` passes an empty option-argument and a bare
# `"$SHADOW_FLAG"` passes an empty positional; both reach the CLI and both fail there.
_SHADOW_EXPANSION = f'${{{_SHADOW_FLAG}:+"${_SHADOW_FLAG}"}}'
_SHADOW_INPUT = "${{ github.event.inputs.shadow }}"
_POKE_GUARD = "github.event.inputs.shadow != 'true' && steps.target.outputs.drci_poke == 'true'"

_CASE_FALLBACK_ARM = "*"
_CASE_RE = re.compile(r'case\s+"\$SHADOW"\s+in\b(.*?)\besac\b', re.DOTALL)
_CASE_ARM_RE = re.compile(r"^[^\S\n]*([^)\s]+)\)", re.MULTILINE)
_NONZERO_EXIT_RE = re.compile(r"\bexit\s+[1-9]\d*\b")
_SHADOW_ASSIGNMENT_RE = re.compile(rf'{_SHADOW_FLAG}=([^"]*)"')

# announce_start writes the in-flight marker; record writes the terminal verdict and both the
# cancelled and failed markers. The review job runs the model and writes no state row at all.
_ROW_WRITING_JOBS = ("announce_start", "record")
_VERDICT_CALL_SITES = 4
_POKE_CALL_SITES = 2

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


def test_drci_poke_is_suppressed_for_shadow() -> None:
    pokes = _invocations(_POKE_CALL)
    found = sorted(_label(job, step) for job, step in pokes)
    assert len(found) == _POKE_CALL_SITES, _drift(
        f"expected {_POKE_CALL_SITES} `{_POKE_CALL}` steps, found {len(found)}: {found}."
    )
    unguarded = sorted(_label(job, step) for job, step in pokes if _field(step, "if") != _POKE_GUARD)
    assert not unguarded, _drift(
        f"these `{_POKE_CALL}` steps are not guarded by exactly `{_POKE_GUARD}`: {unguarded}. The Dr. CI query "
        f"drops shadow rows in its WHERE, so poking for one only spends a refresh that renders nothing new; a "
        f"repo whose entry is not a served, active drci one has no Dr. CI render to refresh; and a status "
        f"function in the guard would drop the implicit success() that ties the poke to the row upload."
    )


def test_shadow_input_defaults_to_not_shadow() -> None:
    declared = _triggers()["workflow_dispatch"]["inputs"]["shadow"]
    assert declared.get("default") is False, _drift(
        f"the `shadow` input declares default {declared.get('default')!r}. A dispatcher that omits the "
        f"input gets this value, so `true` silently shadows every review, and a boolean input with no "
        f"default makes the REST API reject the dispatch outright."
    )


_TOKEN_ACTION = "actions/create-github-app-token@"
_TOKEN_OWNER = "pytorch"
_TOKEN_REPOSITORIES = "${{ steps.target.outputs.name }}"
_TOKEN_PERMISSIONS = {
    # The AI_REVIEW_STARTED marker reads the repo's .github/greenlight/config.yml.
    "announce_start": {"permission-pull-requests": "write", "permission-contents": "read"},
    # The terminal verdict's eligibility lookup reads merge_rules.yaml and expands its team refs.
    "record": {"permission-pull-requests": "write", "permission-contents": "read", "permission-members": "read"},
}


def _token_inputs(job: str) -> dict[str, Any]:
    minting = [step for step in _steps(job) if _field(step, "uses").startswith(_TOKEN_ACTION)]
    assert len(minting) == 1, _drift(f"job {job} has {len(minting)} `{_TOKEN_ACTION}` steps, expected exactly one.")
    inputs = minting[0]["with"]
    assert isinstance(inputs, dict)
    return inputs


@pytest.mark.parametrize("job", sorted(_TOKEN_PERMISSIONS))
def test_app_token_scope_is_pinned(job: str) -> None:
    inputs = _token_inputs(job)
    assert (inputs.get("owner"), inputs.get("repositories")) == (_TOKEN_OWNER, _TOKEN_REPOSITORIES), _drift(
        f"job {job} mints its App token for owner {inputs.get('owner')!r} and repositories "
        f"{inputs.get('repositories')!r}. The token writes pull requests, so any repository added here is one "
        f"more it can approve on."
    )
    permissions = {key: value for key, value in inputs.items() if key.startswith("permission-")}
    assert permissions == _TOKEN_PERMISSIONS[job], _drift(
        f"job {job} mints its App token with {permissions}, expected {_TOKEN_PERMISSIONS[job]}. Anything wider is "
        f"privilege on a job that holds the App key; anything narrower breaks the job's own verdict calls, and on "
        f"the record job the merge-rule check that every authoritative review depends on."
    )


_SIZECHECK_STEP_ID = "sizecheck"
_FILE_CAP_ENV = "MAX_DIFF_FILES"
_FILE_CAP_COMPARISON = f'"$files" -gt "${_FILE_CAP_ENV}"'
_DIFF_PATH = "/tmp/greenlight-pr.diff"  # noqa: S108
_VERDICT_PATH = "/tmp/greenlight-verdict.json"  # noqa: S108
_TOO_LARGE_VERDICT = ROOT / ".claude" / "hooks" / "greenlight" / "too-large-verdict.json"
_BASH = shutil.which("bash") or "/bin/bash"


def _file_cap_drift(detail: str) -> str:
    return f"{_WORKFLOW} drifted from greenlight's file cap: {detail}"


def _sizecheck_step() -> dict[str, Any]:
    gates = [step for job in _JOBS for step in _steps(job) if _field(step, "id") == _SIZECHECK_STEP_ID]
    assert len(gates) == 1, _file_cap_drift(
        f"found {len(gates)} steps with id {_SIZECHECK_STEP_ID}, expected exactly one."
    )
    return gates[0]


def test_size_gate_file_cap_matches_max_diff_files() -> None:
    gate = _sizecheck_step()
    cap = gate.get("env", {}).get(_FILE_CAP_ENV)
    assert str(cap) == str(constants.MAX_DIFF_FILES), _file_cap_drift(
        f"the {_SIZECHECK_STEP_ID} step sets {_FILE_CAP_ENV} to {cap!r}, but constants.MAX_DIFF_FILES is "
        f"{constants.MAX_DIFF_FILES}. They are one cap, and this gate is the only file cap a review has: "
        f"eligibility never lists a PR's files, for any author."
    )
    assert _FILE_CAP_COMPARISON in _field(gate, "run"), _file_cap_drift(
        f"the {_SIZECHECK_STEP_ID} step's run: body no longer contains `{_FILE_CAP_COMPARISON}`, so the cap pinned "
        f"above may be one the gate never compares against. A rewrite of that comparison must update this test."
    )


class _SizecheckRun(NamedTuple):
    returncode: int
    stderr: str
    output: str
    verdict: Path


def _new_files_diff(count: int) -> str:
    """A diff adding ``count`` empty files, three lines each, as git writes them."""
    return "".join(f"diff --git a/f{i} b/f{i}\nnew file mode 100644\nindex 0000000..e69de29\n" for i in range(count))


def _run_sizecheck(tmp_path: Path, diff: str, path_prefix: Path | None = None) -> _SizecheckRun:
    """Run the sizecheck step's own shell on ``diff`` the way the runner does, under ``tmp_path``.

    Both fixed paths move into ``tmp_path``: test_land_reason_guard.py writes
    /tmp/greenlight-verdict.json from other xdist workers.
    """
    gate = _sizecheck_step()
    run = _field(gate, "run")
    for literal in (_DIFF_PATH, _VERDICT_PATH):
        assert literal in run, _file_cap_drift(
            f"the {_SIZECHECK_STEP_ID} step no longer names {literal}, which this test rewrites to run the step; "
            f"point the rewrite at the new path."
        )
    diff_path = tmp_path / "greenlight-pr.diff"
    diff_path.write_text(diff, encoding="utf-8")
    verdict_path = tmp_path / "greenlight-verdict.json"
    output_path = tmp_path / "github-output"
    output_path.touch()
    script = tmp_path / "sizecheck.sh"
    script.write_text(
        run.replace(_DIFF_PATH, shlex.quote(str(diff_path))).replace(_VERDICT_PATH, shlex.quote(str(verdict_path))),
        encoding="utf-8",
    )
    path = os.environ["PATH"] if path_prefix is None else f"{path_prefix}{os.pathsep}{os.environ['PATH']}"
    env = {name: str(value) for name, value in gate["env"].items()}
    env |= {"GITHUB_WORKSPACE": str(ROOT), "GITHUB_OUTPUT": str(output_path), "PATH": path}
    # `bash -e` is how the runner invokes a step that sets no `shell:`.
    result = subprocess.run(  # noqa: S603
        [_BASH, "-e", str(script)], capture_output=True, text=True, check=False, env=env
    )
    return _SizecheckRun(result.returncode, result.stderr, output_path.read_text(encoding="utf-8"), verdict_path)


@pytest.mark.parametrize(
    ("files", "too_large"),
    [(0, False), (constants.MAX_DIFF_FILES, False), (constants.MAX_DIFF_FILES + 1, True)],
    ids=["empty-diff", "at-the-cap", "one-over-the-cap"],
)
def test_size_gate_declines_a_diff_over_the_file_cap(tmp_path: Path, files: int, too_large: bool) -> None:
    diff = _new_files_diff(files)
    caps = _sizecheck_step()["env"]
    # Inside the line and byte caps, so the file count alone decides.
    assert diff.count("\n") <= int(caps["MAX_DIFF_LINES"])
    assert len(diff.encode()) <= int(caps["MAX_DIFF_BYTES"])
    run = _run_sizecheck(tmp_path, diff)
    assert run.returncode == 0, f"exit {run.returncode}, stderr: {run.stderr}"
    assert run.output == f"too_large={'true' if too_large else 'false'}\n", run.stderr
    if too_large:
        assert run.verdict.read_bytes() == _TOO_LARGE_VERDICT.read_bytes()
    else:
        assert not run.verdict.exists()


def test_size_gate_aborts_when_grep_cannot_read_the_diff(tmp_path: Path) -> None:
    shim = tmp_path / "shim"
    shim.mkdir()
    grep = shim / "grep"
    grep.write_text("#!/bin/sh\necho 'grep: read error' >&2\nexit 2\n", encoding="utf-8")
    grep.chmod(0o755)
    run = _run_sizecheck(tmp_path, _new_files_diff(1), path_prefix=shim)
    assert run.returncode != 0, "the gate kept going without a file count, which disables the cap"
    assert run.output == "", f"the gate wrote {run.output!r} without a file count"
    assert not run.verdict.exists()


_TARGET_STEP_ID = "target"
_TARGET_CALL = 'greenlight target --strict --repo "$IN_REPO" --pr "$IN_PR" --head-sha "$IN_HEAD_SHA" >>"$GITHUB_OUTPUT"'
_TARGET_INPUTS = {
    "IN_REPO": "${{ inputs.repo }}",
    "IN_PR": "${{ github.event.inputs.pr_number }}",
    "IN_HEAD_SHA": "${{ github.event.inputs.head_sha }}",
}
_RAW_TARGET_INPUTS = ("inputs.repo", "github.event.inputs.pr_number", "github.event.inputs.head_sha")
_TARGET_OUTPUT = "steps.target.outputs."


def _target(name: str) -> str:
    return f"${{{{ steps.target.outputs.{name} }}}}"


def _text(value: object) -> str:
    return yaml.safe_dump(value, sort_keys=True)


def _target_index(job: str) -> int:
    found = [i for i, step in enumerate(_steps(job)) if step.get("id") == _TARGET_STEP_ID]
    assert len(found) == 1, _drift(f"job {job} has {len(found)} steps with id {_TARGET_STEP_ID}, expected one.")
    return found[0]


@pytest.mark.parametrize("job", sorted(_JOBS))
def test_every_job_validates_the_target_with_the_raw_inputs(job: str) -> None:
    step = _steps(job)[_target_index(job)]
    assert _TARGET_CALL in _field(step, "run"), _drift(f"job {job}'s target step does not run `{_TARGET_CALL}`.")
    env = {**_JOBS[job].get("env", {}), **step.get("env", {})}
    assert {key: env.get(key) for key in _TARGET_INPUTS} == _TARGET_INPUTS, _drift(
        f"job {job}'s target step does not read the three dispatch inputs through env: {env}"
    )
    assert env.get("GH_TOKEN") == "${{ secrets.GITHUB_TOKEN }}", _drift(f"job {job}'s strict read has no token.")
    assert "if" not in step, _drift(f"job {job}'s target step is conditional; every later step needs its outputs.")


_REVIEW_OUTPUTS = ("repo", "drci_poke")


def test_the_review_job_exports_its_validated_target() -> None:
    assert _JOBS["review"]["outputs"] == {name: _target(name) for name in _REVIEW_OUTPUTS}


def _record_target_run(tmp_path: Path, result: str, repo: str, input_repo: str = "") -> list[str]:
    """The ``greenlight target`` arguments the record job's target step passes, with a stub ``uv``."""
    shim = tmp_path / "shim"
    shim.mkdir()
    (shim / "uv").write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8")
    (shim / "uv").chmod(0o755)
    step = _steps("record")[_target_index("record")]
    env = {
        "IN_REPO": input_repo,
        "IN_PR": "7",
        "IN_HEAD_SHA": "a" * 40,
        "REVIEW_RESULT": result,
        "REVIEW_REPO": repo,
        "REVIEW_DRCI_POKE": "p",
    }
    output = tmp_path / "github-output"
    output.touch()
    completed = subprocess.run(  # noqa: S603
        [_BASH, "-e", "-c", _field(step, "run")],
        capture_output=True,
        text=True,
        check=False,
        env={**env, "GITHUB_OUTPUT": str(output), "PATH": f"{shim}{os.pathsep}{os.environ['PATH']}"},
    )
    assert completed.returncode == 0, completed.stderr
    return output.read_text(encoding="utf-8").splitlines()


def test_the_record_job_takes_the_reviews_outputs_on_the_path_that_can_dismiss(tmp_path: Path) -> None:
    step = _steps("record")[_target_index("record")]
    assert {key: value for key, value in step["env"].items() if key.startswith("REVIEW_")} == {
        "REVIEW_RESULT": "${{ needs.review.result }}",
        **{f"REVIEW_{name.upper()}": f"${{{{ needs.review.outputs.{name} }}}}" for name in _REVIEW_OUTPUTS},
    }
    args = _record_target_run(tmp_path, "success", "pytorch/vision", input_repo="pytorch/vision")
    assert args[:5] == ["run", "--project", "greenlight", "greenlight", "target"]
    assert args[5:] == [
        "--from-review",
        "--input-repo",
        "pytorch/vision",
        "--repo",
        "pytorch/vision",
        "--drci-poke",
        "p",
        "--pr",
        "7",
        "--head-sha",
        "a" * 40,
    ]


@pytest.mark.parametrize(
    ("result", "repo"), [("failure", "pytorch/vision"), ("cancelled", ""), ("success", ""), ("skipped", "")]
)
def test_the_record_job_validates_on_its_own_when_the_review_exported_nothing_usable(
    tmp_path: Path, result: str, repo: str
) -> None:
    args = _record_target_run(tmp_path, result, repo)
    assert args[5:] == ["--strict", "--repo", "", "--pr", "7", "--head-sha", "a" * 40]


@pytest.mark.parametrize("job", sorted(_JOBS))
def test_no_step_but_the_target_step_reads_a_raw_target_input(job: str) -> None:
    for index, step in enumerate(_steps(job)):
        if index == _target_index(job):
            continue
        text = _text(step)
        leaked = [expr for expr in _RAW_TARGET_INPUTS if expr in text]
        leaked += [name for name in _TARGET_INPUTS if f"${name}" in text]
        assert not leaked, _drift(f"{_label(job, step)} reads {leaked} rather than the validated target outputs.")
    raw_env = {
        key for key, value in _JOBS[job].get("env", {}).items() if any(e in str(value) for e in _RAW_TARGET_INPUTS)
    }
    assert raw_env <= set(_TARGET_INPUTS), _drift(f"job {job} exposes the raw inputs as {sorted(raw_env)}.")


@pytest.mark.parametrize("job", sorted(_JOBS))
def test_the_target_step_precedes_every_use_of_its_outputs(job: str) -> None:
    target = _target_index(job)
    early = [_label(job, step) for step in _steps(job)[:target] if _TARGET_OUTPUT in _text(step)]
    assert not early, _drift(f"these steps read the target outputs before the target step runs: {early}")
    assert any(_TARGET_OUTPUT in _text(step) for step in _steps(job)[target + 1 :])


def test_the_review_job_validates_the_target_before_the_reviewed_checkout() -> None:
    steps = _steps("review")
    checkouts = [i for i, step in enumerate(steps) if _field(step, "uses").startswith("actions/checkout@")]
    assert checkouts[0] < _target_index("review") < checkouts[1], _drift(
        "the review job must check out test-infra, then validate the target, then check out the reviewed repo."
    )
    setup = [_field(step, "uses") for step in steps[: _target_index("review")]]
    assert any(uses.startswith("actions/setup-python@") for uses in setup)
    assert "./.github/actions/setup-uv" in setup


@pytest.mark.parametrize(
    ("snippet", "flags"), [(_VERDICT_CALL, ("repo", "pr", "head-sha")), (_POKE_CALL, ("repo", "pr"))]
)
def test_verdict_and_poke_calls_pass_the_validated_target(snippet: str, flags: tuple[str, ...]) -> None:
    wanted = {"repo": ("REPO", "repo"), "pr": ("PR_NUMBER", "pr"), "head-sha": ("HEAD_SHA", "head_sha")}
    for job, step in _invocations(snippet):
        run = _field(step, "run")
        for flag in flags:
            var, output = wanted[flag]
            assert f'--{flag} "${var}"' in run, _drift(f'{_label(job, step)} does not pass --{flag} "${var}".')
            assert step.get("env", {}).get(var) == _target(output), _drift(
                f"{_label(job, step)} sets {var} to {step.get('env', {}).get(var)!r}, not {_target(output)}."
            )
        assert "pytorch/pytorch" not in run, _drift(f"{_label(job, step)} still names pytorch/pytorch.")


def test_the_concurrency_group_keeps_pytorchs_name_and_separates_other_repos() -> None:
    group = _DOC["concurrency"]["group"]
    assert group == (
        "${{ inputs.repo == '' && format('greenlight-pr-review-{0}', github.event.inputs.pr_number) "
        "|| format('greenlight-pr-review-{0}:{1}', inputs.repo, github.event.inputs.pr_number) }}"
    ), _drift(f"the concurrency group is {group!r}.")
    assert _DOC["concurrency"]["cancel-in-progress"] is True


def test_the_repo_input_defaults_to_pytorch_and_the_pr_is_a_number() -> None:
    inputs = _triggers()["workflow_dispatch"]["inputs"]
    assert inputs["repo"]["default"] == ""
    assert inputs["repo"]["required"] is False
    assert inputs["repo"]["type"] == "string"
    assert inputs["pr_number"]["type"] == "number"


def _review_step(*, name: str | None = None, step_id: str | None = None, uses: str | None = None) -> dict[str, Any]:
    found = [
        step
        for step in _steps("review")
        if (name is None or step.get("name") == name)
        and (step_id is None or step.get("id") == step_id)
        and (uses is None or _field(step, "uses").startswith(uses))
    ]
    assert len(found) == 1, _drift(f"expected one review step matching {name=} {step_id=} {uses=}, found {len(found)}")
    return found[0]


def test_the_review_job_checks_out_and_sanitizes_the_validated_repo() -> None:
    checkouts = [step for step in _steps("review") if _field(step, "uses").startswith("actions/checkout@")]
    assert len(checkouts) == 3
    _, reviewed, skills = checkouts
    assert {key: reviewed["with"][key] for key in ("repository", "ref", "path")} == {
        "repository": _target("repo"),
        "ref": _target("head_sha"),
        "path": _target("checkout"),
    }
    assert reviewed["with"]["persist-credentials"] is False
    assert skills["with"]["repository"] == _target("repo")
    assert skills["with"]["ref"] == "main"
    for step in _steps("review"):
        run = _field(step, "run")
        if "sanitize-untrusted-checkout.sh" in run or "assert-loaded-instructions.py" in run:
            assert step["env"]["CHECKOUT"] == _target("checkout"), _drift(f"{_label('review', step)} env")
            assert "$CHECKOUT" in run, _drift(run)
            assert "/pytorch" not in run, _drift(run)
            assert " pytorch " not in run, _drift(run)


@pytest.mark.parametrize("name", ["Produce PR diff pinned to head_sha", "Collect PR metadata", "Collect stack context"])
def test_the_review_api_steps_name_the_validated_repo(name: str) -> None:
    step = _review_step(name=name)
    assert step["env"]["REPO"] == _target("repo")
    assert step["env"]["PR_NUMBER"] == _target("pr")
    run = _field(step, "run")
    assert "pytorch/pytorch" not in run, _drift(f"{name} still names pytorch/pytorch.")
    assert '"pytorch"' not in run, _drift(f"{name} still names the pytorch owner or repo.")
    assert '--repo "$REPO"' in run


def test_the_stack_steps_graphql_takes_the_repo_as_variables() -> None:
    run = _field(_review_step(name="Collect stack context"), "run")
    assert '-f owner="${REPO%%/*}" -f name="${REPO#*/}" -F number="$number"' in run
    assert "query($owner: String!, $name: String!, $number: Int!)" in run
    assert "repository(owner: $owner, name: $name)" in run


_PROMPT_EXPRESSIONS = {_target("repo"), _target("pr"), _target("head_sha"), _target("checkout")}


def test_the_prompt_reads_only_the_four_target_outputs() -> None:
    prompt = _review_step(uses="anthropics/claude-code-action")["with"]["prompt"]
    assert set(re.findall(r"\$\{\{.*?\}\}", prompt)) == _PROMPT_EXPRESSIONS


_PLACEHOLDER = "__GREENLIGHT_CHECKOUT__"


def test_the_hook_settings_name_the_validated_checkout() -> None:
    step = _review_step(name="Set up review hooks")
    run = _field(step, "run")
    match = re.search(r"<<'EOF'\n(.*?)\n\s*EOF\n", run, re.DOTALL)
    assert match is not None, _drift("the settings heredoc is no longer single-quoted.")
    settings = json.loads(match.group(1))
    reads = [hook["command"] for block in settings["hooks"]["PreToolUse"] for hook in block["hooks"]]
    assert f"python3 .claude/hooks/greenlight/restrict-read.py {_PLACEHOLDER}" in reads
    excludes = settings["claudeMdExcludes"]
    assert excludes
    assert all(entry.startswith(f"**/{_PLACEHOLDER}/") for entry in excludes)
    assert step["env"]["CHECKOUT"] == _target("checkout")
    after = run[match.end() :]
    assert f'sed -i "s/{_PLACEHOLDER}/$CHECKOUT/g" .claude/settings.local.json' in after
    assert "pytorch | target) ;;" in after.split("sed -i", 1)[0], _drift("the checkout is not checked before sed.")


def _run_step(step: dict[str, Any], env: dict[str, str], cwd: Path, replace: dict[str, str] | None = None) -> str:
    output = cwd / "github-output"
    output.touch()
    run = _field(step, "run")
    for old, new in (replace or {}).items():
        assert old in run
        run = run.replace(old, new)
    result = subprocess.run(  # noqa: S603
        [_BASH, "-e", "-c", run],
        capture_output=True,
        text=True,
        check=False,
        cwd=cwd,
        env={**env, "GITHUB_OUTPUT": str(output), "PATH": os.environ["PATH"]},
    )
    assert result.returncode == 0, result.stderr
    return output.read_text(encoding="utf-8")


_REPO_POLICY_SCRIPT = ".claude/hooks/greenlight/repo-policy.py"
_STAGE_CALL = f'python3 {_REPO_POLICY_SCRIPT} stage "$REPO" pytorch-main-skills .claude'
_TOUCHES_CALL = f"python3 {_REPO_POLICY_SCRIPT} touches {_DIFF_PATH}"
_SCHEMA = ROOT / ".claude" / "hooks" / "greenlight" / "verdict-schema.json"


def _review_index(predicate: Any) -> int:
    found = [i for i, step in enumerate(_steps("review")) if predicate(step)]
    assert len(found) == 1, _drift(f"expected one matching review step, found {len(found)}")
    return found[0]


def test_the_trusted_checkout_takes_the_skills_and_the_greenlight_directory() -> None:
    skills = [step for step in _steps("review") if _field(step, "uses").startswith("actions/checkout@")][2]
    assert skills["with"]["path"] == "pytorch-main-skills"
    assert skills["with"]["sparse-checkout"] == ".claude/skills\n.github/greenlight\n"
    assert skills["with"]["fetch-depth"] == 1


def test_the_policy_steps_run_in_order_before_the_model() -> None:
    def named(name: str) -> int:
        return _review_index(lambda step: step.get("name") == name)

    trusted = _review_index(lambda step: step.get("with", {}).get("path") == "pytorch-main-skills")
    stage = _review_index(lambda step: step.get("id") == "policy")
    sanitize = _review_index(lambda step: "sanitize-untrusted-checkout.sh" in _field(step, "run"))
    diff = named("Produce PR diff pinned to head_sha")
    touches = _review_index(lambda step: step.get("id") == "touches")
    model = _review_index(lambda step: _field(step, "uses").startswith("anthropics/"))
    order = [
        trusted,
        stage,
        sanitize,
        diff,
        touches,
        named("Decline oversized diffs"),
        named("Decide whether the model runs"),
    ]
    assert order == sorted(order), _drift(f"the policy steps run out of order: {order}")
    assert order[-1] < model, _drift("the model runs before the policy steps")
    assert "if" not in _steps("review")[stage]


_NO_POLICY_VERDICT = ROOT / ".claude" / "hooks" / "greenlight" / "no-policy-verdict.json"
_GREENLIGHT_FILES_VERDICT = ROOT / ".claude" / "hooks" / "greenlight" / "greenlight-files-verdict.json"


@pytest.mark.parametrize(
    ("path", "reason", "topic"),
    [
        (_NO_POLICY_VERDICT, "review_error", "- Review policy"),
        (_GREENLIGHT_FILES_VERDICT, "not_trivial", "- Merge authorization"),
    ],
    ids=["no-policy", "greenlight-files"],
)
def test_the_canned_policy_verdicts_are_valid_outlined_no_lands(path: Path, reason: str, topic: str) -> None:
    written = json.loads(path.read_text(encoding="utf-8"))
    jsonschema.validate(written, json.loads(_SCHEMA.read_text(encoding="utf-8")))
    assert (written["status"], written["reason"]) == ("NO_LAND", reason)
    assert reason in constants.ALLOWED_REASONS
    first, *details = written["message"].split("\n")
    assert first == topic
    assert 1 <= len(details) <= 3
    assert all(line.startswith("  - ") for line in details)
    assert "pytorch/" not in written["message"], "the canned message names no repo"


@pytest.mark.parametrize(("step_id", "path"), [("policy", _NO_POLICY_VERDICT), ("touches", _GREENLIGHT_FILES_VERDICT)])
def test_the_policy_steps_copy_their_canned_verdict(step_id: str, path: Path) -> None:
    run = _field(_review_step(step_id=step_id), "run")
    assert f'cp "$GITHUB_WORKSPACE/{path.relative_to(ROOT).as_posix()}" {_VERDICT_PATH}' in run
    assert "jq" not in run


def _stage_workspace(tmp_path: Path, policy: bytes | None) -> Path:
    trusted = tmp_path / "pytorch-main-skills"
    trusted.mkdir()
    git = ["git", "-C", str(trusted), "-c", "user.name=t", "-c", "user.email=t@example.com"]
    subprocess.run([*git, "init", "-q"], check=True)  # noqa: S603
    (trusted / "README").write_text("x\n", encoding="utf-8")
    if policy is not None:
        (trusted / ".github" / "greenlight").mkdir(parents=True)
        (trusted / ".github" / "greenlight" / "review.md").write_bytes(policy)
    subprocess.run([*git, "add", "-A"], check=True)  # noqa: S603
    subprocess.run([*git, "commit", "-q", "-m", "main"], check=True)  # noqa: S603
    return tmp_path


_VALID_POLICY = b"".join(
    f"## {name}\nx\n".encode() for name in ("User-facing surface", "Merge-gating workflows", "Lint gate", "Test layout")
)


@pytest.mark.parametrize(("policy", "staged"), [(_VALID_POLICY, True), (None, False), (b"# no sections\n", False)])
def test_the_stage_step_declines_a_repo_without_a_valid_policy(
    tmp_path: Path, policy: bytes | None, staged: bool
) -> None:
    step = _review_step(step_id="policy")
    assert step["env"] == {"REPO": _target("repo")}
    workspace = _stage_workspace(tmp_path, policy)
    verdict = tmp_path / "verdict.json"
    replace = {_REPO_POLICY_SCRIPT: str(ROOT / _REPO_POLICY_SCRIPT), _VERDICT_PATH: str(verdict)}

    output = _run_step(step, {"REPO": "pytorch/vision", "GITHUB_WORKSPACE": str(ROOT)}, workspace, replace)

    slot = workspace / ".claude" / "skills" / "greenlight-review" / "repo-policy.md"
    assert output == f"staged={'true' if staged else 'false'}\n"
    assert slot.exists() is staged
    if staged:
        assert not verdict.exists()
    else:
        assert verdict.read_bytes() == _NO_POLICY_VERDICT.read_bytes()


def test_the_stage_step_reads_only_the_validated_repo() -> None:
    assert _STAGE_CALL in _field(_review_step(step_id="policy"), "run")
    assert _TOUCHES_CALL in _field(_review_step(step_id="touches"), "run")


@pytest.mark.parametrize(
    ("diff", "touches"),
    [
        ("diff --git a/README b/README\n", "false"),
        ("diff --git a/.github/greenlight b/.github/greenlight\nnew file mode 120000\n", "true"),
    ],
    ids=["unrelated", "greenlight-directory"],
)
def test_the_touches_step_declines_a_change_to_the_greenlight_directory(
    tmp_path: Path, diff: str, touches: str
) -> None:
    step = _review_step(step_id="touches")
    assert step["if"] == "steps.policy.outputs.staged == 'true'"
    assert "env" not in step
    diff_path = tmp_path / "pr.diff"
    diff_path.write_text(diff, encoding="utf-8")
    verdict = tmp_path / "verdict.json"
    replace = {
        _REPO_POLICY_SCRIPT: str(ROOT / _REPO_POLICY_SCRIPT),
        _DIFF_PATH: str(diff_path),
        _VERDICT_PATH: str(verdict),
    }

    assert _run_step(step, {"GITHUB_WORKSPACE": str(ROOT)}, tmp_path, replace) == f"touches={touches}\n"

    if touches == "false":
        assert not verdict.exists()
    else:
        assert verdict.read_bytes() == _GREENLIGHT_FILES_VERDICT.read_bytes()


_SKIP_GUARD = "steps.model.outputs.skip != 'true'"


def test_the_size_gate_runs_only_after_both_policy_gates_passed_and_feeds_the_model_decision() -> None:
    assert (
        _sizecheck_step()["if"] == "steps.policy.outputs.staged == 'true' && steps.touches.outputs.touches == 'false'"
    )
    for output in ("steps.sizecheck.outputs", "steps.touches.outputs"):
        readers = [_label("review", s) for s in _steps("review") if output in _text(s)]
        assert readers[-1] == "review / Decide whether the model runs", _drift(f"{output} is read by {readers}")
    readers = [_label("review", s) for s in _steps("review") if "steps.policy.outputs" in _text(s)]
    assert readers == [
        "review / Decline changes to the repository's GreenLight files",
        "review / Decline oversized diffs",
        "review / Decide whether the model runs",
    ], _drift(f"staged is read by {readers}")


@pytest.mark.parametrize(
    ("staged", "touches", "too_large", "skip"),
    [
        ("true", "false", "false", "false"),
        ("true", "false", "true", "true"),
        ("true", "true", "", "true"),
        ("false", "", "", "true"),
        ("true", "false", "", "true"),
        ("true", "", "false", "true"),
        ("", "", "", "true"),
    ],
)
def test_the_model_runs_only_with_a_staged_policy_and_a_diff_both_gates_passed(
    tmp_path: Path, staged: str, touches: str, too_large: str, skip: str
) -> None:
    step = _review_step(step_id="model")
    assert step["env"] == {
        "STAGED": "${{ steps.policy.outputs.staged }}",
        "TOUCHES": "${{ steps.touches.outputs.touches }}",
        "TOO_LARGE": "${{ steps.sizecheck.outputs.too_large }}",
    }
    env = {"STAGED": staged, "TOUCHES": touches, "TOO_LARGE": too_large}
    assert _run_step(step, env, tmp_path) == f"skip={skip}\n"


def test_every_model_dependent_step_is_gated_on_the_model_decision() -> None:
    gated = {
        str(step.get("name")): _field(step, "if") for step in _steps("review") if "steps.model." in _field(step, "if")
    }
    assert gated == {
        "Compute review budget deadlines": _SKIP_GUARD,
        "Run Green Light review": _SKIP_GUARD,
        "Assert no untrusted instructions were loaded": f"always() && {_SKIP_GUARD}",
    }


_RUN_INPUT_RE = re.compile(r"\$\{\{[^}]*\b(?:inputs|github\.event\.inputs)\.")


@pytest.mark.parametrize(
    "path", sorted(p.relative_to(ROOT).as_posix() for p in ROOT.glob(".github/workflows/greenlight-*.yml"))
)
def test_no_dispatch_input_is_expanded_inside_a_run_script(path: str) -> None:
    document = yaml.safe_load((ROOT / path).read_text(encoding="utf-8"))
    leaks = [
        f"{job} / {step.get('name')}"
        for job, spec in document["jobs"].items()
        for step in spec.get("steps", [])
        if _RUN_INPUT_RE.search(str(step.get("run", "")))
    ]
    assert not leaks, f"{path}: these steps expand a dispatch input inside run: {leaks}; pass it through env"
