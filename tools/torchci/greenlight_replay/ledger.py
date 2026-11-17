"""The review workflow shapes the replay reproduces, and how it treats each of their parts.

A policy pull request can change any step of ``greenlight-pr-review.yml``, and a step the
harness does not know about is one the replay silently runs differently from CI. So each
arm's workflow is reduced to its shape (:mod:`.ledger_shape`), and
:func:`.policy.materialize` refuses, before running any of the arm's code, an arm whose
shape no :class:`Variant` here has.

A variant lists its shape's entry digests in order; :data:`CLASSES` gives each digest's
class, the one place that is written: derived from the arm's tree, run as the arm's own
code, reproduced by a named harness module, or not reproduced, with the reason.
``PARITY.md`` beside this module says when a shape may be registered and when a variant
is retired.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple

from torchci.greenlight_replay.ledger_shape import Entry, shape, shape_digest


__all__ = [
    "CLASSES",
    "REGISTRY",
    "VARIANTS",
    "Class",
    "Kind",
    "UnregisteredShapeError",
    "Variant",
    "require_registered",
]

_PARITY = "tools/torchci/greenlight_replay/PARITY.md"


class UnregisteredShapeError(ValueError):
    """The arm's review workflow has a shape no registered variant has."""


class Kind(enum.Enum):
    DERIVED = "derived"
    ARM_CODE = "run as the arm's own code"
    REPRODUCED = "reproduced"
    NOT_REPRODUCED = "not reproduced"


class Class(NamedTuple):
    kind: Kind
    detail: str

    def __str__(self) -> str:
        return f"{self.kind.value}: {self.detail}"


@dataclass(frozen=True)
class Variant:
    """A registered shape: its entry digests in order, and why the harness reproduces it."""

    name: str
    digests: tuple[str, ...]
    notes: tuple[str, ...] = ()

    @property
    def digest(self) -> str:
        return shape_digest(self.digests)

    def classes(self) -> tuple[Class, ...]:
        return tuple(CLASSES[digest] for digest in self.digests)


def require_registered(document: dict[str, Any], root: Path, path: Path) -> Variant:
    """The variant the arm's shape is registered as; refuses an unregistered shape."""
    entries = shape(document, root, path)
    variant = REGISTRY.get(shape_digest(tuple(entry.digest for entry in entries)))
    if variant is not None:
        return variant
    known = {digest for each in VARIANTS for digest in each.digests}
    unknown = [entry for entry in entries if entry.digest not in known]
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
        + "Port what changed to the harness, confirm the replay reproduces it, then "
        f"add a Variant with this shape's digests and their CLASSES, as {_PARITY} says."
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


_ABSENT = Class(Kind.REPRODUCED, "absent, so no workflow-level value reaches a step")
_CONCURRENCY = Class(
    Kind.NOT_REPRODUCED,
    "it cancels a superseded review of the same pull request; a replay runs each to "
    "its end",
)
_REVIEW_JOB = Class(
    Kind.DERIVED,
    "the review budgets, by workflow.review_budgets; its runner, environment, "
    "permissions and job timeout are the serving path, not reproduced",
)
_POLICY_CHECKOUT = Class(Kind.REPRODUCED, "policy.materialize: the arm's tree")
_PYTHON = Class(
    Kind.NOT_REPRODUCED,
    "the hook interpreter: the hooks and the detector run under the host's python3",
)
_UV = Class(
    Kind.NOT_REPRODUCED,
    "arm_code runs greenlight under the harness's interpreter and PyYAML, not the "
    "environment uv builds from greenlight/uv.lock",
)
_TARGET = Class(
    Kind.ARM_CODE, "arm_code.resolve_target runs the arm's greenlight target"
)
_CHECKOUT = Class(
    Kind.REPRODUCED,
    "checkout.WorktreePool: the head SHA, in the directory greenlight target names",
)
_TRUSTED_SKILLS = Class(
    Kind.REPRODUCED,
    "trusted_skills.materialize_trusted_skills, from the reviewed repo's main as it "
    "is when the replay runs",
)
_SANITIZE = Class(
    Kind.ARM_CODE, "sweep.sanitize_checkout runs the arm's sanitize script"
)
_AWS = Class(Kind.NOT_REPRODUCED, "the serving path: the replay's own credentials")
_DIFF = Class(Kind.REPRODUCED, "inputs.py: the merge base against the head SHA")
_KEEP_POLICY = Class(
    Kind.REPRODUCED,
    "workspace.install_policy_half keeps only the policy file greenlight target "
    "names; arm_code.no_policy_verdict runs the step's own jq program",
)
_SIZE_GATE = Class(
    Kind.REPRODUCED, "size_gate.apply_size_gate counts; the caps are derived"
)
_DECIDE = Class(
    Kind.REPRODUCED,
    "sweep.py and runner.canned_result: without a policy file, or past the size "
    "gate, the canned verdict and no model",
)
_METADATA = Class(Kind.REPRODUCED, "inputs.py: the pull request's metadata")
_STACK = Class(
    Kind.REPRODUCED,
    "stack.py and stack_native.py, the step pinned by stack_step.STACK_CONTEXT_BY_PIN",
)
_HOOKS = Class(
    Kind.DERIVED,
    "settings.derive_hook_settings: the heredoc, its checkout substituted as the "
    "step's sed does",
)
_DEADLINES = Class(Kind.REPRODUCED, "reviewer_env.py: the epochs from the budgets")
_ACTION = Class(
    Kind.DERIVED,
    "the prompt, model, effort, tools, timeout and output style; the session itself "
    "is declared in PARITY.md",
)
_DETECTOR = Class(
    Kind.ARM_CODE, "arm_code.run_detector runs the arm's detector after a session"
)
_ARTIFACT = Class(
    Kind.NOT_REPRODUCED, "it carries the verdict to the record job; read in place"
)
_USAGE = Class(Kind.NOT_REPRODUCED, "usage telemetry, no input to the verdict")
_RECORD_JOB = Class(
    Kind.ARM_CODE,
    "arm_code.accept_verdict runs its validation step and the arm's greenlight "
    "verdict --dry-run; what it does to the pull request after is not reproduced",
)

CLASSES: dict[str, Class] = {
    "7cd5a6a653ba5b1b64ea39200058238092fb4acbb4cccaa874642b55cb8d2d3d": _ABSENT,
    "76a145570576db3b35df1420b958ba5299a75121708670ddc6c678648e840044": _ABSENT,
    "e5e934acd336e53d56c56a8165524868d9a1664e77ea4af219576b09b85d29be": _ABSENT,
    "6db573cfbb5b39384127ace6d10298dc13e5797adc58a64de95e1a49f3687768": _CONCURRENCY,
    "77be50222a343498cd2a758883ef255dd29c7088de0c701e7bf7660ff5931c9a": _CONCURRENCY,
    "a5e27b7013084dfe669b82898c46e084b93ad3aa46580ef2b35876db8d2bc033": _REVIEW_JOB,
    "a81948f1d3f0078667de5bff1f19759f34b9923dc03bac1db84b59bc7e20a7eb": _POLICY_CHECKOUT,
    "d79ce1de2c982d133b2a2cb6bff714a8e572c2ce2acac7bc4984fb0576cb31ea": _PYTHON,
    "f9cb096a13851f61dc820b11eab297fac21407a823e2e852a216ce3eeaf5da66": _UV,
    "4cf325da87c138c6d790d4fc54730ed775644a755a027cd87826f2051f952f4d": _UV,
    "767b0e4fa03d4e648f6a8b73fa0bf6be64d2bc5ec334570771a322bed4036d7b": _TARGET,
    "bcf900075fa3a5b175447e367e73243f2a0954bb3c9d9161be1c1ce1b64133d6": _CHECKOUT,
    "8bae4f70646f0996bc0886b0fae27ed07309434a39beeaac1159fe0bd1b25189": _CHECKOUT,
    "45d2c5a1593b330c80b051a349280e31cb4b9f5526af96fa80099a2d137f18d7": _TRUSTED_SKILLS,
    "e460fb8caa1c977c38a3001978535a0f4e6201efebecdf7cbbc2bba173d19d7c": _TRUSTED_SKILLS,
    "2507a043857a275b2701cbd53cb37563f8c1ddbba786bb8ddd83c914f1acb59f": _SANITIZE,
    "3dca5cb950bc87519ff04b26762de0a62f1480eaae6e7d43ae6f66d9817c4aa7": _SANITIZE,
    "bc60721709b65d88e176e482aedc6e9fb9b0331bbdde5fa189549917ea5d93a0": _AWS,
    "0d7df117d9a977df2ba9462159bf75e87871ebb458600b9fd73e641731734d20": _DIFF,
    "467e6e97650ffb04f64aa4a472440615af12d41dd3330b4900ff60545d44635e": _DIFF,
    "0e2e64aa266a38993f7089c497ff60464d57c78815a2643a2b9dbf01f894add6": _KEEP_POLICY,
    "eae68e0fce25d6829f7a4ff6d9e5b2a018e081a2273a837342b20d3b1b4f4535": _SIZE_GATE,
    "5c395841d4a8104595775d396b95e433c07eeae41691818cb69198eabad121da": _SIZE_GATE,
    "cfba62c390ba2bf1c83a3ca42ccdd04cbadad63a7ea7a5f55038feb90a65ab17": _DECIDE,
    "18fb5b7de607e664b1aa6f0bb9734339df5e6c38d7cec11dd8cf4b0db095f4e5": _METADATA,
    "fb21a66247e9b03124c8cb643463c798b7d8c2b72826bb569765a39bbe58eb11": _METADATA,
    "de00a4a14b4e2845c890b1fa5bb69d03d509953fe68e70bc8fd569ea5b2a7e62": _STACK,
    "d80d86eb370e4588473e820b962e8aca4dc331d08a59912fe2608b9815e2b737": _HOOKS,
    "2b64d67082fa4cb4e447d2ec8ea65843bcbed4f37a7d060d8cf491ca87a837b9": _HOOKS,
    "5f8da8ec5afa9225988b1738adcc7bd066523a4b46543d6bce5971d517c5f65f": _DEADLINES,
    "178d4df0e031758c38790b68a0e9b640594ceb899b925fde3b5847fd4701f237": _DEADLINES,
    "91e3b572bbfd6e2bd306658cf1c7eb09d29004f02b84239343e8312604a97ce7": _ACTION,
    "8c86c24515375c7f35e4fd844b2e3517eb89e442d186394a163a4a10efe14d60": _ACTION,
    "b17b8fab93f9cb1f1c54768231dd7c2ee9d88cb0cfcf82053cff2284219201f1": _DETECTOR,
    "9f167792a42401228774a35c4f35e0009eabf00cb55b12555dd455219c138929": _DETECTOR,
    "3e557713a57e8b6a64b3bb88d524a07034c90615662c2e4273a2360306d8a7e4": _ARTIFACT,
    "2324847d795b47aa31fd05ae1d4eea5a49681ada1d73c7472c68ff33c8f799aa": _USAGE,
    "f049ef580b181b54bc630e23b33f6b31fbe0c1da94463406a8f9d2b7a7a3f0a0": _RECORD_JOB,
    "355bcb166dff57b0b6f02a5a0d8202088294d481d6d898fbd7c8bf0cdbff6415": _RECORD_JOB,
}

VARIANTS: tuple[Variant, ...] = (
    Variant(
        name="repo-aware: every job resolves its target with greenlight target",
        digests=(
            "7cd5a6a653ba5b1b64ea39200058238092fb4acbb4cccaa874642b55cb8d2d3d",
            "76a145570576db3b35df1420b958ba5299a75121708670ddc6c678648e840044",
            "e5e934acd336e53d56c56a8165524868d9a1664e77ea4af219576b09b85d29be",
            "6db573cfbb5b39384127ace6d10298dc13e5797adc58a64de95e1a49f3687768",
            "a5e27b7013084dfe669b82898c46e084b93ad3aa46580ef2b35876db8d2bc033",
            "a81948f1d3f0078667de5bff1f19759f34b9923dc03bac1db84b59bc7e20a7eb",
            "d79ce1de2c982d133b2a2cb6bff714a8e572c2ce2acac7bc4984fb0576cb31ea",
            "f9cb096a13851f61dc820b11eab297fac21407a823e2e852a216ce3eeaf5da66",
            "4cf325da87c138c6d790d4fc54730ed775644a755a027cd87826f2051f952f4d",
            "767b0e4fa03d4e648f6a8b73fa0bf6be64d2bc5ec334570771a322bed4036d7b",
            "bcf900075fa3a5b175447e367e73243f2a0954bb3c9d9161be1c1ce1b64133d6",
            "45d2c5a1593b330c80b051a349280e31cb4b9f5526af96fa80099a2d137f18d7",
            "2507a043857a275b2701cbd53cb37563f8c1ddbba786bb8ddd83c914f1acb59f",
            "bc60721709b65d88e176e482aedc6e9fb9b0331bbdde5fa189549917ea5d93a0",
            "0d7df117d9a977df2ba9462159bf75e87871ebb458600b9fd73e641731734d20",
            "0e2e64aa266a38993f7089c497ff60464d57c78815a2643a2b9dbf01f894add6",
            "eae68e0fce25d6829f7a4ff6d9e5b2a018e081a2273a837342b20d3b1b4f4535",
            "cfba62c390ba2bf1c83a3ca42ccdd04cbadad63a7ea7a5f55038feb90a65ab17",
            "18fb5b7de607e664b1aa6f0bb9734339df5e6c38d7cec11dd8cf4b0db095f4e5",
            "de00a4a14b4e2845c890b1fa5bb69d03d509953fe68e70bc8fd569ea5b2a7e62",
            "d80d86eb370e4588473e820b962e8aca4dc331d08a59912fe2608b9815e2b737",
            "5f8da8ec5afa9225988b1738adcc7bd066523a4b46543d6bce5971d517c5f65f",
            "91e3b572bbfd6e2bd306658cf1c7eb09d29004f02b84239343e8312604a97ce7",
            "b17b8fab93f9cb1f1c54768231dd7c2ee9d88cb0cfcf82053cff2284219201f1",
            "3e557713a57e8b6a64b3bb88d524a07034c90615662c2e4273a2360306d8a7e4",
            "2324847d795b47aa31fd05ae1d4eea5a49681ada1d73c7472c68ff33c8f799aa",
            "f049ef580b181b54bc630e23b33f6b31fbe0c1da94463406a8f9d2b7a7a3f0a0",
        ),
    ),
    Variant(
        name="pytorch/pytorch only: no target step (main at e4933b776)",
        digests=(
            "7cd5a6a653ba5b1b64ea39200058238092fb4acbb4cccaa874642b55cb8d2d3d",
            "76a145570576db3b35df1420b958ba5299a75121708670ddc6c678648e840044",
            "e5e934acd336e53d56c56a8165524868d9a1664e77ea4af219576b09b85d29be",
            "77be50222a343498cd2a758883ef255dd29c7088de0c701e7bf7660ff5931c9a",
            "a5e27b7013084dfe669b82898c46e084b93ad3aa46580ef2b35876db8d2bc033",
            "a81948f1d3f0078667de5bff1f19759f34b9923dc03bac1db84b59bc7e20a7eb",
            "8bae4f70646f0996bc0886b0fae27ed07309434a39beeaac1159fe0bd1b25189",
            "e460fb8caa1c977c38a3001978535a0f4e6201efebecdf7cbbc2bba173d19d7c",
            "3dca5cb950bc87519ff04b26762de0a62f1480eaae6e7d43ae6f66d9817c4aa7",
            "bc60721709b65d88e176e482aedc6e9fb9b0331bbdde5fa189549917ea5d93a0",
            "467e6e97650ffb04f64aa4a472440615af12d41dd3330b4900ff60545d44635e",
            "5c395841d4a8104595775d396b95e433c07eeae41691818cb69198eabad121da",
            "fb21a66247e9b03124c8cb643463c798b7d8c2b72826bb569765a39bbe58eb11",
            "de00a4a14b4e2845c890b1fa5bb69d03d509953fe68e70bc8fd569ea5b2a7e62",
            "2b64d67082fa4cb4e447d2ec8ea65843bcbed4f37a7d060d8cf491ca87a837b9",
            "178d4df0e031758c38790b68a0e9b640594ceb899b925fde3b5847fd4701f237",
            "8c86c24515375c7f35e4fd844b2e3517eb89e442d186394a163a4a10efe14d60",
            "9f167792a42401228774a35c4f35e0009eabf00cb55b12555dd455219c138929",
            "3e557713a57e8b6a64b3bb88d524a07034c90615662c2e4273a2360306d8a7e4",
            "2324847d795b47aa31fd05ae1d4eea5a49681ada1d73c7472c68ff33c8f799aa",
            "355bcb166dff57b0b6f02a5a0d8202088294d481d6d898fbd7c8bf0cdbff6415",
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

REGISTRY = {variant.digest: variant for variant in VARIANTS}
