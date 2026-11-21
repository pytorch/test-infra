"""The review workflow's steps the replay derives settings from or runs as written.

:mod:`.workflow` reads the values the model runs under; this module reads the steps
around it: the heredoc that writes the hook settings, the action step's per-run timeout
and output style, the instruction-loading detector, the record job's verdict validation
and the canned verdict a repo without a review policy gets. Each is found by shape,
never by ``name`` or position, and each reader refuses any form it does not parse
exactly, because a step the replay misreads is one it runs differently from CI.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from torchci.greenlight_replay.workflow import (
    _action_step,
    _job_steps,
    _jobs,
    _only,
    _steps,
    ACTION_USES_PREFIX,
)


__all__ = [
    "DETECTOR_RELPATH",
    "MANIFEST_BASENAME",
    "MANIFEST_COMMAND",
    "MAX_RUN_TIMEOUT_MINUTES",
    "NoPolicyProgram",
    "RECORD_VERDICT_ASSIGNMENT",
    "RecordStep",
    "SENTINEL_BASENAME",
    "SENTINEL_COMMAND",
    "SETTINGS_LOCAL_RELPATH",
    "action_output_style",
    "action_timeout_minutes",
    "detector_untrusted_dirname",
    "hook_settings_text",
    "no_policy_program",
    "record_step",
    "record_verdict_line",
]

SETTINGS_LOCAL_RELPATH = ".claude/settings.local.json"
DETECTOR_RELPATH = ".claude/hooks/greenlight/assert-loaded-instructions.py"
RECORD_VERDICT_ASSIGNMENT = "verdict=/tmp/greenlight-verdict.json"  # noqa: S108

# Where the SessionStart and InstructionsLoaded hooks leave what the detector reads. The
# heredoc keeps $RUNNER_TEMP literal, so each hook's shell expands it when it runs.
SENTINEL_BASENAME = "hooks_ran.sentinel"
MANIFEST_BASENAME = "loaded_instructions.jsonl"
SENTINEL_COMMAND = f'echo ok > "$RUNNER_TEMP/{SENTINEL_BASENAME}"'
MANIFEST_COMMAND = f'{{ cat; echo; }} >> "$RUNNER_TEMP/{MANIFEST_BASENAME}"'

# The replay job's AWS credentials last an hour and are rewritten every 15 minutes, so
# a review allowed longer than this could outlive the credentials it started with.
MAX_RUN_TIMEOUT_MINUTES = 40

OUTPUT_STYLE_KEY = "outputStyle"
SETTINGS_KEY = "settings"
TIMEOUT_KEY = "timeout-minutes"

TARGET_CHECKOUT_EXPR = "${{ steps.target.outputs.checkout }}"
EVAL_HASH_EXPR = "${{ github.event.inputs.eval_hash }}"
_TARGET_OUTPUT = re.compile(r"\$\{\{ steps\.target\.outputs\.([a-z_]+) \}\}")

# The detector step's two forms: one names the checkout ``greenlight target``
# validated through the step's env, the other names ``pytorch`` literally, as a
# workflow without a target step does.
_DETECTOR_RUN = (
    f"python3 {DETECTOR_RELPATH}"
    f' --manifest "$RUNNER_TEMP/{MANIFEST_BASENAME}"'
    f' --sentinel "$RUNNER_TEMP/{SENTINEL_BASENAME}"'
    ' --untrusted-root "$GITHUB_WORKSPACE/{}"'
)
DETECTOR_CHECKOUT_RUN = _DETECTOR_RUN.format("$CHECKOUT")
DETECTOR_PYTORCH_RUN = _DETECTOR_RUN.format("pytorch")

_HEREDOC_OPEN = re.compile(
    rf"^\s*cat\s*>\s*{re.escape(SETTINGS_LOCAL_RELPATH)}\s*<<\s*'(\w+)'\s*$"
)
_VARIABLE = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)")
_ASSIGNED = re.compile(
    r"^\s*(?:(?:local|export|readonly)\s+)?([A-Za-z_][A-Za-z0-9_]*)=|"
    r"^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b",
    re.MULTILINE,
)
_NO_POLICY_JQ = re.compile(
    r"jq\s+-n((?:\s+--arg\s+[A-Za-z_]\w*\s+\"\$[A-Za-z_]\w*\")*)\s+"
    r"'([^']*)'\s*>\s*/tmp/greenlight-verdict\.json"
)
_JQ_ARG = re.compile(r"--arg\s+([A-Za-z_]\w*)\s+\"\$([A-Za-z_]\w*)\"")


@dataclass(frozen=True)
class RecordStep:
    """The record job's verdict validation: its ``run:`` and the shell it runs under.

    ``shell`` is the step's, else its job's ``defaults.run.shell``, else the
    workflow's. None is no shell set, which GitHub runs as ``bash -e {0}``; ``"bash"``
    it runs as ``bash --noprofile --norc -eo pipefail {0}``.
    """

    run: str
    shell: str | None


@dataclass(frozen=True)
class NoPolicyProgram:
    """The jq program the keep-policy step declines with, and what each ``--arg`` binds.

    ``args`` maps each jq variable to the ``greenlight target`` output its step env
    variable carries, such as ``("repo", "repo")``, in the order the step passes them.
    """

    program: str
    args: tuple[tuple[str, str], ...]


def hook_settings_text(document: dict[str, Any], path: Path) -> str:
    """The body of the one quoted heredoc that writes the hook settings file.

    Quoted, because the unquoted form would expand ``$RUNNER_TEMP`` when the file is
    written rather than when each hook runs. Exactly one step may write it, and that
    step exactly one heredoc.
    """
    bodies = [
        body
        for step in _steps(document)
        for body in _heredoc_bodies(str(step.get("run") or ""))
    ]
    if len(bodies) != 1:
        raise ValueError(
            f"{path}: expected exactly one quoted heredoc writing "
            f"{SETTINGS_LOCAL_RELPATH}, found {len(bodies)}"
        )
    return bodies[0]


def _heredoc_bodies(run: str) -> list[str]:
    bodies: list[str] = []
    lines = run.split("\n")
    index = 0
    while index < len(lines):
        opened = _HEREDOC_OPEN.match(lines[index])
        index += 1
        if opened is None:
            continue
        body: list[str] = []
        while index < len(lines) and lines[index] != opened.group(1):
            body.append(lines[index])
            index += 1
        if index == len(lines):
            raise ValueError(f"the heredoc writing {SETTINGS_LOCAL_RELPATH} never ends")
        index += 1
        bodies.append("\n".join(body))
    return bodies


def action_timeout_minutes(document: dict[str, Any], path: Path) -> int:
    """The action step's ``timeout-minutes``: each review's wall clock, in minutes."""
    value = _action_step(document, path).get(TIMEOUT_KEY)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 0 < value <= MAX_RUN_TIMEOUT_MINUTES
    ):
        raise ValueError(
            f"{path}: the {ACTION_USES_PREFIX} step's {TIMEOUT_KEY} is {value!r}; the "
            f"replay needs a literal positive integer of at most "
            f"{MAX_RUN_TIMEOUT_MINUTES}, which its credentials outlive"
        )
    return value


def action_output_style(document: dict[str, Any], path: Path) -> str | None:
    """The output style the action step's ``with.settings`` sets, or None without one.

    The action merges that JSON into the user settings layer. Only ``outputStyle`` is
    reproduced, so a settings object carrying anything else is refused.
    """
    raw = (_action_step(document, path).get("with") or {}).get(SETTINGS_KEY)
    if raw is None:
        return None
    try:
        settings = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        settings = None
    if (
        not isinstance(settings, dict)
        or set(settings) != {OUTPUT_STYLE_KEY}
        or not isinstance(settings[OUTPUT_STYLE_KEY], str)
    ):
        raise ValueError(
            f"{path}: the {ACTION_USES_PREFIX} step's with.{SETTINGS_KEY} is {raw!r}; "
            f"the replay reproduces only a JSON object holding a string "
            f"{OUTPUT_STYLE_KEY}"
        )
    return settings[OUTPUT_STYLE_KEY]


def detector_untrusted_dirname(
    document: dict[str, Any], path: Path, checkout: str
) -> str:
    """The workspace directory the detector step holds no instruction file may load from.

    The step must run the detector in one of its two known forms: naming the checkout
    the target step validated, through an env ``CHECKOUT`` carrying exactly that
    output, or naming ``pytorch`` with no env at all.
    """
    step = _only(
        [
            step
            for step in _steps(document)
            if DETECTOR_RELPATH in str(step.get("run") or "")
        ],
        f"step whose run: names {DETECTOR_RELPATH}",
        path,
    )
    run = str(step.get("run")).strip()
    env = step.get("env") or {}
    if run == DETECTOR_CHECKOUT_RUN and env == {"CHECKOUT": TARGET_CHECKOUT_EXPR}:
        return checkout
    if run == DETECTOR_PYTORCH_RUN and not env:
        return "pytorch"
    raise ValueError(
        f"{path}: the detector step runs {run!r} with env {env!r}, which is neither "
        "form the replay reproduces"
    )


def record_step(document: dict[str, Any], path: Path) -> RecordStep:
    """The record job's step that validates the verdict file, and its shell.

    It is the one step assigning ``verdict=/tmp/greenlight-verdict.json``. The replay
    runs it with that assignment pointed at the run's verdict and ``EVAL_HASH`` set,
    so the step may read no other variable it does not assign itself, and no
    expression; its job must take ``EVAL_HASH`` from the dispatch input.
    """
    job, step = _record_job_and_step(document, path)
    run = str(step["run"])
    if _stripped_lines(run).count(RECORD_VERDICT_ASSIGNMENT) != 1:
        raise ValueError(f"{path}: the record step assigns its verdict more than once")
    shell = _shell(document, job, step)
    if "${{" in run or step.get("env") or shell not in (None, "bash"):
        raise ValueError(
            f"{path}: the record step uses an expression, an env block or a shell "
            "the replay does not reproduce"
        )
    assigned = {
        name for match in _ASSIGNED.finditer(run) for name in match.groups() if name
    }
    foreign = set(_VARIABLE.findall(run)) - assigned - {"EVAL_HASH"}
    if foreign:
        raise ValueError(
            f"{path}: the record step reads {sorted(foreign)}, which the replay does "
            "not set"
        )
    if (job.get("env") or {}).get("EVAL_HASH") != EVAL_HASH_EXPR:
        raise ValueError(
            f"{path}: the record job does not take EVAL_HASH from {EVAL_HASH_EXPR}"
        )
    return RecordStep(run=run, shell=shell)


def _record_job_and_step(
    document: dict[str, Any], path: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The record job and its step assigning the verdict; exactly one, or refused."""
    found = [
        (job, step)
        for job in _jobs(document)
        for step in _job_steps(job)
        if RECORD_VERDICT_ASSIGNMENT in _stripped_lines(step.get("run"))
    ]
    if len(found) != 1:
        raise ValueError(
            f"{path}: expected exactly one step assigning {RECORD_VERDICT_ASSIGNMENT}, "
            f"found {len(found)}"
        )
    return found[0]


def _shell(
    document: dict[str, Any], job: dict[str, Any], step: dict[str, Any]
) -> str | None:
    """The shell GitHub runs ``step`` under: its own, else the nearest default."""
    for holder in (step, _run_defaults(job), _run_defaults(document)):
        if holder.get("shell") is not None:
            return str(holder["shell"])
    return None


def _run_defaults(holder: dict[str, Any]) -> dict[str, Any]:
    defaults = holder.get("defaults") or {}
    run = defaults.get("run") if isinstance(defaults, dict) else None
    return run if isinstance(run, dict) else {}


def record_verdict_line(run: str) -> int:
    """The index of the verdict assignment among the lines of a validated record run."""
    return _stripped_lines(run).index(RECORD_VERDICT_ASSIGNMENT)


def no_policy_program(document: dict[str, Any], path: Path) -> NoPolicyProgram:
    """The ``jq -n`` program the keep-policy step writes its canned NO_LAND with.

    Exactly one ``jq -n`` in the workflow may write the verdict file, and each of its
    ``--arg`` values must be an env variable of its step carrying a target output.
    """
    found = [
        (step, match)
        for step in _steps(document)
        for match in _NO_POLICY_JQ.finditer(str(step.get("run") or ""))
    ]
    if len(found) != 1:
        raise ValueError(
            f"{path}: expected exactly one jq -n program writing the verdict file, "
            f"found {len(found)}"
        )
    step, match = found[0]
    env = step.get("env") or {}
    args: list[tuple[str, str]] = []
    for name, variable in _JQ_ARG.findall(match.group(1)):
        bound = _TARGET_OUTPUT.fullmatch(str(env.get(variable, "")))
        if bound is None:
            raise ValueError(
                f"{path}: the canned verdict's --arg {name} reads ${variable}, which "
                "its step does not take from a target output"
            )
        args.append((name, bound.group(1)))
    return NoPolicyProgram(program=match.group(2), args=tuple(args))


def _stripped_lines(run: Any) -> list[str]:
    return [line.strip() for line in str(run or "").split("\n")]
