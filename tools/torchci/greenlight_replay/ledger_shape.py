"""The shape of an arm's review workflow: what :mod:`.ledger` registers and checks.

**The shape** is an ordered list of entries, each a :func:`.stack_step.step_digest`: the
workflow's ``env``, ``defaults``, ``permissions`` and ``concurrency``; the review job's
keys other than ``steps``; each of its steps, and after a step whose ``uses:`` is
``./<path>`` that local action's ``action.yml``; then the whole record job. The review job
is the one holding the action step and the record job the one holding the verdict
validation, each found as :mod:`.workflow` and :mod:`.workflow_steps` find them. A step's
``name`` is not digested, so retitling one leaves the shape as it was.

**What the harness derives or runs is masked**: the value becomes :data:`MASK` and the key
stays, so retuning a value is a policy change the replay honours, while adding or removing
one changes the shape. Masked are the review budgets, the action step's ``prompt``,
``settings`` and ``timeout-minutes`` and the values of its ``claude_args`` flags, the size
gate's caps, the hook settings heredoc's body and the record job's validation ``run:``.
The stack step is masked out whole, :data:`.stack_step.STACK_CONTEXT_BY_PIN` being its
one check; its position still counts.
"""

from __future__ import annotations

import copy
import hashlib
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, NamedTuple

import yaml
from torchci.greenlight_replay.stack_step import stack_steps, step_digest
from torchci.greenlight_replay.workflow import (
    _action_step,
    _flag_values,
    _jobs,
    _only,
    CLAUDE_ARGS_KEY,
    MAX_DIFF_BYTES_KEY,
    MAX_DIFF_FILES_KEY,
    MAX_DIFF_LINES_KEY,
    PROMPT_KEY,
    REVIEW_BUDGET_KEYS,
    SIZECHECK_STEP_ID,
)
from torchci.greenlight_replay.workflow_steps import (
    _heredoc_bodies,
    _stripped_lines,
    RECORD_VERDICT_ASSIGNMENT,
    SETTINGS_KEY,
    TIMEOUT_KEY,
)


__all__ = [
    "ACTION_MANIFESTS",
    "MASK",
    "WORKFLOW_KEYS",
    "Entry",
    "local_actions",
    "shape",
    "shape_digest",
]

MASK = "<derived or run by the replay>"
WORKFLOW_KEYS = ("env", "defaults", "permissions", "concurrency")
# The runner reads the first of these a local action directory holds.
ACTION_MANIFESTS = ("action.yml", "action.yaml")
_STACK_MASK = {"stack step": "pinned by stack_step.STACK_CONTEXT_BY_PIN"}
_CAP_KEYS = (MAX_DIFF_LINES_KEY, MAX_DIFF_BYTES_KEY, MAX_DIFF_FILES_KEY)


class Entry(NamedTuple):
    """One part of the shape; ``label`` names it in messages and is not digested."""

    label: str
    digest: str


def shape_digest(digests: tuple[str, ...]) -> str:
    """The digest of a whole shape: its entry digests, in order."""
    return hashlib.sha256("\n".join(digests).encode("ascii")).hexdigest()


def shape(document: dict[str, Any], root: Path, path: Path) -> tuple[Entry, ...]:
    """The arm's shape: every entry, masked, in order; local actions read under ``root``."""
    entries = [
        Entry(f"workflow {key}", step_digest({key: document.get(key)}))
        for key in WORKFLOW_KEYS
    ]
    review = _review_job(document, path)
    keys = copy.deepcopy(
        {key: value for key, value in review.items() if key != "steps"}
    )
    _mask_keys(keys.get("env"), REVIEW_BUDGET_KEYS)
    entries.append(Entry("review job, its keys but steps", step_digest(keys)))
    steps = _job_steps(review)
    stacks = stack_steps(steps)
    action = _action_step(document, path)
    for index, step in enumerate(steps):
        label = f"review step {index} {str(step.get('name') or '')!r}"
        if any(step is stack for stack in stacks):
            entries.append(Entry(label, step_digest(_STACK_MASK)))
            continue
        entries.append(Entry(label, step_digest(_masked_step(step, step is action))))
        local = _local_action(step, path)
        if local is not None:
            manifest = _manifest(root, local, path)
            entries.append(
                Entry(f"{label}, local action {manifest}", _digest(root / manifest))
            )
    record = copy.deepcopy(_record_job(document, path))
    for step in _job_steps(record):
        if _is_record_step(step):
            step["run"] = MASK
    entries.append(Entry("record job", step_digest(record)))
    return tuple(entries)


def local_actions(document: dict[str, Any], root: Path, path: Path) -> list[str]:
    """The manifest of each local action the review job's steps use, relative to ``root``."""
    found = []
    for step in _job_steps(_review_job(document, path)):
        local = _local_action(step, path)
        if local is not None:
            found.append(_manifest(root, local, path))
    return found


def _job_steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    return [step for step in job.get("steps") or [] if isinstance(step, dict)]


def _review_job(document: dict[str, Any], path: Path) -> dict[str, Any]:
    action = _action_step(document, path)
    return _only(
        [
            job
            for job in _jobs(document)
            if any(step is action for step in _job_steps(job))
        ],
        "job holding the action step",
        path,
    )


def _record_job(document: dict[str, Any], path: Path) -> dict[str, Any]:
    return _only(
        [
            job
            for job in _jobs(document)
            if any(_is_record_step(step) for step in _job_steps(job))
        ],
        f"job with a step assigning {RECORD_VERDICT_ASSIGNMENT}",
        path,
    )


def _is_record_step(step: dict[str, Any]) -> bool:
    return RECORD_VERDICT_ASSIGNMENT in _stripped_lines(step.get("run"))


def _masked_step(step: dict[str, Any], is_action: bool) -> dict[str, Any]:
    masked = copy.deepcopy(step)
    if is_action:
        _mask_keys(masked, (TIMEOUT_KEY,))
        with_ = masked.get("with")
        _mask_keys(with_, (PROMPT_KEY, SETTINGS_KEY))
        if isinstance(with_, dict) and CLAUDE_ARGS_KEY in with_:
            with_[CLAUDE_ARGS_KEY] = _masked_claude_args(with_[CLAUDE_ARGS_KEY])
    if masked.get("id") == SIZECHECK_STEP_ID:
        _mask_keys(masked.get("env"), _CAP_KEYS)
    run = masked.get("run")
    if isinstance(run, str):
        masked["run"] = _masked_heredoc(run)
    return masked


def _masked_claude_args(raw: Any) -> Any:
    """Each flag in its order with its value masked, parsed as ``workflow.claude_args`` does.

    Arguments that parser refuses stay as written, so the step's digest matches no
    registered shape.
    """
    try:
        flags = _flag_values(shlex.split(str(raw)), Path())
    except ValueError:
        return raw
    return " ".join(f"{flag} {MASK}" for flag in flags)


def _masked_heredoc(run: str) -> str:
    """``run`` with the body of each hook settings heredoc masked.

    A body that is empty or appears more than once in ``run`` stays as written, so the
    step's digest matches no registered shape rather than masking the wrong text.
    """
    for body in _heredoc_bodies(run):
        if body and run.count(body) == 1:
            run = run.replace(body, MASK)
    return run


def _mask_keys(mapping: Any, keys: tuple[str, ...]) -> None:
    if isinstance(mapping, dict):
        for key in keys:
            if key in mapping:
                mapping[key] = MASK


def _local_action(step: dict[str, Any], path: Path) -> PurePosixPath | None:
    uses = str(step.get("uses") or "")
    if not uses.startswith("./"):
        return None
    local = PurePosixPath(uses[2:])
    if local.is_absolute() or ".." in local.parts:
        raise ValueError(f"{path}: refusing the local action {uses!r}")
    return local


def _manifest(root: Path, local: PurePosixPath, path: Path) -> str:
    for name in ACTION_MANIFESTS:
        candidate = local / name
        resolved = (root / candidate).resolve()
        if resolved.is_file() and resolved.is_relative_to(root.resolve()):
            return str(candidate)
    raise ValueError(
        f"{path}: the local action ./{local} has no action.yml in the tree"
    )


def _digest(manifest: Path) -> str:
    document = yaml.safe_load(manifest.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError(f"{manifest} did not parse as a mapping")
    return step_digest(document)
