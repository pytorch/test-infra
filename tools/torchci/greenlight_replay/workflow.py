"""What the greenlight review workflow declares, read by shape rather than by position.

``.github/workflows/greenlight-pr-review.yml`` *is* the policy under test. Everything
the CI job hands the model is read back out of it here -- the prompt, the model and
effort, the tool allowlist, the two diff-size caps and the three review budgets -- so
that a policy pull request which retunes any of them is honoured rather than silently
replaced by the baseline numbers.

Four properties of that reading are load-bearing.

**Steps are located by shape, never by index or by ``name``.** The action step is found
by its ``uses`` prefix and the size gate by its ``id``. A policy pull request is free to
reorder the review job's steps or retitle them, and either would otherwise select some
other step's ``with:`` block and run the reviewer on a prompt nobody wrote.

**``--allowedTools`` is translated to ``tools``.** Under
``anthropics/claude-code-action`` it is the allowlist, but the replay harness invokes
``claude`` directly, where ``--allowedTools`` only pre-approves permission prompts and
imposes no ceiling at all; ``--tools`` is the hard allowlist. Carrying the flag across
under its own name would hand the untrusted reviewer Bash and Edit.

**A missing diff cap is fatal rather than absent.** The workflow spells the caps as
string literals and carries a commented-out ``vars.*`` lookup that returns once the
pinned actionlint is bumped past 1.6.24. Reading that lookup as ``None`` would disable
the size gate and feed the model a diff it cannot read in full.

**A missing review budget is equally fatal, and the budgets live on the job's ``env``
rather than on a step.** ``budget-reminder.sh`` reads absolute epochs
(``GREENLIGHT_REVIEW_START_EPOCH`` and the three ``*_DEADLINE`` values), which the
workflow derives from these minutes in a step of its own; given a value that is unset or
non-numeric the hook exits 0 without emitting anything. A silent hook is not merely
unpaced: its past-hard-deadline tier is where the LAND/NO_LAND decision rule is restated
to the model, and the reviewer has neither Bash nor a clock, so those reminders are its
only signal that time is passing. Defaulting a missing budget would reintroduce exactly
that silence, which is why every one of the three is required.

One parsing footnote: PyYAML implements YAML 1.1, so the workflow's ``on:`` key loads as
the boolean ``True`` rather than as the string ``"on"``. Nothing here keys off it, and
nothing added here should.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

import yaml


__all__ = [
    "ACTION_USES_PREFIX",
    "ALLOWED_TOOLS_FLAG",
    "EFFORT_FLAG",
    "MAX_DIFF_BYTES_KEY",
    "MAX_DIFF_LINES_KEY",
    "MODEL_FLAG",
    "PROMPT_KEY",
    "REVIEW_BUDGET_KEYS",
    "SIZECHECK_STEP_ID",
    "WORKFLOW_RELPATH",
    "claude_args",
    "diff_caps",
    "load",
    "prompt",
    "review_budgets",
]

WORKFLOW_RELPATH = ".github/workflows/greenlight-pr-review.yml"

ACTION_USES_PREFIX = "anthropics/claude-code-action"
SIZECHECK_STEP_ID = "sizecheck"

PROMPT_KEY = "prompt"
CLAUDE_ARGS_KEY = "claude_args"

MAX_DIFF_LINES_KEY = "MAX_DIFF_LINES"
MAX_DIFF_BYTES_KEY = "MAX_DIFF_BYTES"

# Target, soft, hard -- the order the runner unpacks them in, and the order they
# must stay in: each tier's nudge is chosen by which deadline has passed.
REVIEW_BUDGET_KEYS = (
    "GREENLIGHT_REVIEW_TARGET_BUDGET_MIN",
    "GREENLIGHT_REVIEW_SOFT_BUDGET_MIN",
    "GREENLIGHT_REVIEW_HARD_BUDGET_MIN",
)

MODEL_FLAG = "--model"
EFFORT_FLAG = "--effort"
ALLOWED_TOOLS_FLAG = "--allowedTools"

_CAP_CONSEQUENCE = (
    "Reading it as absent would disable the size gate and feed the model a diff it "
    "cannot read in full."
)
_BUDGET_CONSEQUENCE = (
    "Without every deadline the budget-reminder hook exits without emitting, and the "
    "pacing and decision-rule text the policy promises the model never arrives."
)


def load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"policy tree has no {path}")
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError(f"{path} did not parse as a mapping")
    return document


def prompt(document: dict[str, Any], path: Path) -> str:
    """The action step's prompt, placeholders unresolved."""
    template = _action_with(document, path).get(PROMPT_KEY)
    if not isinstance(template, str) or not template.strip():
        raise ValueError(
            f"{path}: the {ACTION_USES_PREFIX} step declares no with.{PROMPT_KEY}"
        )
    return template


def claude_args(document: dict[str, Any], path: Path) -> tuple[str, str, str]:
    """The model, the effort and the tool allowlist, in that order."""
    raw = _action_with(document, path).get(CLAUDE_ARGS_KEY)
    if not isinstance(raw, str):
        raise ValueError(
            f"{path}: the {ACTION_USES_PREFIX} step declares no with.{CLAUDE_ARGS_KEY}"
        )
    values = _flag_values(shlex.split(raw))
    return (
        _require_flag(values, MODEL_FLAG, path),
        _require_flag(values, EFFORT_FLAG, path),
        _require_flag(values, ALLOWED_TOOLS_FLAG, path),
    )


def diff_caps(document: dict[str, Any], path: Path) -> tuple[int, int]:
    """The line cap and the byte cap the size gate declines on."""
    step = _only(
        [step for step in _steps(document) if step.get("id") == SIZECHECK_STEP_ID],
        f"step with id: {SIZECHECK_STEP_ID}",
        path,
    )
    env = step.get("env") or {}
    owner = f"the {SIZECHECK_STEP_ID} step"
    return (
        _uint_env(env, MAX_DIFF_LINES_KEY, path, owner, _CAP_CONSEQUENCE),
        _uint_env(env, MAX_DIFF_BYTES_KEY, path, owner, _CAP_CONSEQUENCE),
    )


def review_budgets(document: dict[str, Any], path: Path) -> tuple[int, int, int]:
    """The target, soft and hard review budgets, in minutes.

    Found by which job's ``env`` carries them rather than by the job's name, for the
    same reason the action step is found by its ``uses``. A job carrying only some of
    the three still resolves here, so the error names the key that is missing instead
    of reporting the whole job as absent.
    """
    job = _only(
        [
            job
            for job in _jobs(document)
            if any(key in (job.get("env") or {}) for key in REVIEW_BUDGET_KEYS)
        ],
        f"job declaring {REVIEW_BUDGET_KEYS[0]}",
        path,
    )
    env = job.get("env") or {}
    target, soft, hard = (
        _uint_env(env, key, path, "the review job", _BUDGET_CONSEQUENCE)
        for key in REVIEW_BUDGET_KEYS
    )
    return target, soft, hard


def _jobs(document: dict[str, Any]) -> list[dict[str, Any]]:
    jobs = document.get("jobs") or {}
    return [job for job in jobs.values() if isinstance(job, dict)]


def _steps(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Every step of every job, so a renamed or split job cannot hide one."""
    return [
        step
        for job in _jobs(document)
        for step in (job.get("steps") or [])
        if isinstance(step, dict)
    ]


def _only(
    candidates: list[dict[str, Any]], description: str, path: Path
) -> dict[str, Any]:
    if len(candidates) != 1:
        raise ValueError(
            f"{path}: expected exactly one {description}, found {len(candidates)}"
        )
    return candidates[0]


def _action_with(document: dict[str, Any], path: Path) -> dict[str, Any]:
    step = _only(
        [
            step
            for step in _steps(document)
            if str(step.get("uses") or "").startswith(ACTION_USES_PREFIX)
        ],
        f"step with uses: {ACTION_USES_PREFIX}",
        path,
    )
    return step.get("with") or {}


def _flag_values(tokens: list[str]) -> dict[str, str]:
    """``--flag value`` and ``--flag=value`` pairs; a bare flag carries no value."""
    # Split the "=" spelling apart first, so one pairing rule covers both forms.
    flat: list[str] = []
    for token in tokens:
        name, separator, inline = token.partition("=")
        flat.extend([name, inline] if separator and name.startswith("--") else [token])
    return {
        token: flat[index + 1]
        for index, token in enumerate(flat)
        if token.startswith("--")
        and index + 1 < len(flat)
        and not flat[index + 1].startswith("--")
    }


def _require_flag(values: dict[str, str], flag: str, path: Path) -> str:
    value = values.get(flag)
    if not value:
        raise ValueError(
            f"{path}: {CLAUDE_ARGS_KEY} carries no {flag} value. Replaying under an "
            "unstated model, effort or tool allowlist is not replaying the policy."
        )
    return value


def _uint_env(
    env: dict[str, Any], key: str, path: Path, owner: str, consequence: str
) -> int:
    """One non-negative integer out of a workflow ``env`` block.

    The digit test mirrors the workflow's own ``case "$X" in '' | *[!0-9]*)`` shape
    check. ``int()`` would be looser -- it takes surrounding whitespace and the
    ``"2_000"`` digit separator -- so a value the shell rejects outright could
    otherwise parse to a different number here.
    """
    if key not in env:
        raise ValueError(f"{path}: {owner} declares no {key}. {consequence}")
    text = str(env[key])
    if not text.isascii() or not text.isdigit():
        raise ValueError(
            f"{path}: {key} is {env[key]!r}, expected a non-negative integer"
        )
    return int(text)
