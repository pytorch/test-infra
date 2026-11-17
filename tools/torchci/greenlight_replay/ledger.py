"""The review workflow shapes the replay reproduces, and how it treats each of their parts.

A policy pull request can change any step of ``greenlight-pr-review.yml``, and a step the
harness does not know about is one the replay silently runs differently from CI. So each
arm's workflow is reduced to its shape (:mod:`.ledger_shape`), and
:func:`.policy.materialize` refuses, before running any of the arm's code, an arm whose
shape no :class:`Variant` here has.

A variant lists its shape's parts in order, each a :class:`.ledger_parts.Part` pairing an
entry digest with its class; :data:`CLASSES` is derived from them. ``PARITY.md`` beside
this module says when a shape may be registered and when a variant is retired.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from torchci.greenlight_replay import ledger_parts as parts
from torchci.greenlight_replay.ledger_parts import Class, Part
from torchci.greenlight_replay.ledger_shape import Entry, shape, shape_digest


__all__ = [
    "CLASSES",
    "CLAUDE_CODE_BY_ACTION_PIN",
    "REGISTRY",
    "VARIANTS",
    "UnregisteredShapeError",
    "Variant",
    "require_registered",
]

_PARITY = "tools/torchci/greenlight_replay/PARITY.md"

# The Claude Code build each registered action pin runs: its bundled
# @anthropic-ai/claude-agent-sdk 0.3.<n> is Claude Code 2.1.<n>. The CI replay installs
# the head's, so greenlight-policy-replay.yml's CLAUDE_CODE_VERSION must equal it.
CLAUDE_CODE_BY_ACTION_PIN = {
    "9ca9355b36297178e28d37c799d1c9c8a28e6507": "2.1.280",
}


class UnregisteredShapeError(ValueError):
    """The arm's review workflow has a shape no registered variant has."""


@dataclass(frozen=True)
class Variant:
    """A registered shape: its parts in order, and why the harness reproduces it."""

    name: str
    parts: tuple[Part, ...]
    notes: tuple[str, ...] = ()

    @property
    def digests(self) -> tuple[str, ...]:
        return tuple(part.digest for part in self.parts)

    @property
    def digest(self) -> str:
        return shape_digest(self.digests)


def require_registered(document: dict[str, Any], root: Path, path: Path) -> Variant:
    """The variant the arm's shape is registered as; refuses an unregistered shape."""
    entries = shape(document, root, path)
    variant = REGISTRY.get(shape_digest(tuple(entry.digest for entry in entries)))
    if variant is not None:
        return variant
    unknown = [entry for entry in entries if entry.digest not in CLASSES]
    raise UnregisteredShapeError(
        f"{path}: the review workflow's shape is no variant registered in "
        "greenlight_replay.ledger, so the replay cannot claim to run it as CI does. "
        + (
            "These entries have a digest no registered shape has:\n"
            if unknown
            else "Every entry is registered, but not in this order or combination; "
            "these differ from the nearest registered shape:\n"
        )
        + "".join(
            f"  {entry.label}: {entry.digest}\n"
            for entry in unknown or _misplaced(entries)
        )
        + "If this arm is a replay's base arm, the merge base of the pull request "
        "under test, rebase the branch onto a main that carries a registered shape. "
        "Otherwise port what changed to the harness, confirm the replay reproduces "
        f"it, then register a Variant of this shape, as {_PARITY} says."
    )


def _misplaced(entries: tuple[Entry, ...]) -> list[Entry]:
    """The entries whose position differs from the registered shape matching most."""

    def matching(variant: Variant) -> int:
        return sum(entry.digest == d for entry, d in zip(entries, variant.digests))

    nearest = max(VARIANTS, key=matching).digests
    return [
        entry
        for index, entry in enumerate(entries)
        if index >= len(nearest) or entry.digest != nearest[index]
    ] or list(entries)


VARIANTS: tuple[Variant, ...] = (
    Variant(
        name="repo-aware: every job resolves its target with greenlight target",
        parts=(
            parts.WORKFLOW_ENV,
            parts.WORKFLOW_DEFAULTS,
            parts.WORKFLOW_PERMISSIONS,
            parts.REPO_AWARE_CONCURRENCY,
            parts.REVIEW_JOB,
            parts.POLICY_CHECKOUT_STEP,
            parts.PYTHON_STEP,
            parts.UV_STEP,
            parts.UV_ACTION,
            parts.TARGET_STEP,
            parts.REPO_AWARE_CHECKOUT_STEP,
            parts.REPO_AWARE_TRUSTED_SKILLS_STEP,
            parts.REPO_AWARE_SANITIZE_STEP,
            parts.AWS_STEP,
            parts.REPO_AWARE_DIFF_STEP,
            parts.KEEP_POLICY_STEP,
            parts.REPO_AWARE_SIZE_GATE_STEP,
            parts.DECIDE_STEP,
            parts.REPO_AWARE_METADATA_STEP,
            parts.STACK_STEP,
            parts.REPO_AWARE_HOOKS_STEP,
            parts.REPO_AWARE_DEADLINES_STEP,
            parts.REPO_AWARE_ACTION_STEP,
            parts.REPO_AWARE_DETECTOR_STEP,
            parts.ARTIFACT_STEP,
            parts.USAGE_STEP,
            parts.REPO_AWARE_RECORD_JOB,
        ),
    ),
    Variant(
        name="pytorch/pytorch only: no target step (main from 6f7274a0e)",
        parts=(
            parts.WORKFLOW_ENV,
            parts.WORKFLOW_DEFAULTS,
            parts.WORKFLOW_PERMISSIONS,
            parts.PYTORCH_ONLY_CONCURRENCY,
            parts.REVIEW_JOB,
            parts.POLICY_CHECKOUT_STEP,
            parts.PYTORCH_ONLY_CHECKOUT_STEP,
            parts.PYTORCH_ONLY_TRUSTED_SKILLS_STEP,
            parts.PYTORCH_ONLY_SANITIZE_STEP,
            parts.AWS_STEP,
            parts.PYTORCH_ONLY_DIFF_STEP,
            parts.PYTORCH_ONLY_SIZE_GATE_STEP,
            parts.PYTORCH_ONLY_METADATA_STEP,
            parts.STACK_STEP,
            parts.PYTORCH_ONLY_HOOKS_STEP,
            parts.PYTORCH_ONLY_DEADLINES_STEP,
            parts.PYTORCH_ONLY_ACTION_STEP,
            parts.PYTORCH_ONLY_DETECTOR_STEP,
            parts.ARTIFACT_STEP,
            parts.USAGE_STEP,
            parts.PYTORCH_ONLY_RECORD_JOB,
        ),
        notes=(
            "No target, keep-policy or decide step: arm_code.resolve_target names "
            "pytorch/pytorch in ./pytorch with no policy file, and the model runs "
            "unless the size gate declines, as the repo-aware decide step has it for "
            "pytorch/pytorch.",
            "The checkouts, the diff, metadata and stack reads and the prompt name "
            "pytorch/pytorch and ./pytorch literally: the values greenlight target "
            "outputs for pytorch/pytorch.",
            "The stack step is stack_step.PYTORCH_ONLY_STEP_SHA256, which collects "
            "pytorch/pytorch's context as the repo-aware step does.",
            "The hooks heredoc names pytorch where the repo-aware one has the "
            "__GREENLIGHT_CHECKOUT__ placeholder, and runs restrict-read.py with no "
            "argument, which that tree's script reads as ./pytorch; the derived "
            "settings are otherwise the repo-aware ones.",
            "The detector names $GITHUB_WORKSPACE/pytorch literally, the second form "
            "workflow_steps.detector_untrusted_dirname reads.",
            "The action pin is the repo-aware one. The record job passes "
            "pytorch/pytorch literally and pokes Dr. CI without the target's "
            "drci_poke, which pytorch/pytorch's entry sets; its validation step is "
            "the repo-aware one.",
            "The review job sets up no Python, so its hooks run under the runner's "
            "python3, as the replay's do; its concurrency group is the repo-aware "
            "one for pytorch/pytorch.",
        ),
    ),
)

CLASSES: dict[str, Class] = {
    part.digest: part.cls for variant in VARIANTS for part in variant.parts
}
REGISTRY = {variant.digest: variant for variant in VARIANTS}
