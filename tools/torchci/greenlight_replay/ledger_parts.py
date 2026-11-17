"""Every part of a registered review workflow shape: its digest, once, and its class.

A :class:`Part` pairs one :mod:`.ledger_shape` entry digest with its :class:`Class`: derived
from the arm's tree, run as the arm's own code, reproduced by a named harness module, or
not reproduced, with the reason. :mod:`.ledger` builds each registered variant out of these
names. A part two variants share is one name; the ``REPO_AWARE_`` and ``PYTORCH_ONLY_``
prefixes name the version of a part each variant has.
"""

from __future__ import annotations

import enum
from typing import NamedTuple


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


class Part(NamedTuple):
    cls: Class
    digest: str


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
    Kind.ARM_CODE,
    "workspace.sanitize_checkout runs the arm's sanitize script in the harness's "
    "environment",
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
_METADATA = Class(
    Kind.REPRODUCED,
    "inputs.py: the pull request's metadata, its comments cut off at the replayed "
    "verdict",
)
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
    Kind.ARM_CODE, "detector.run_detector runs the arm's detector after a session"
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

WORKFLOW_ENV = Part(
    _ABSENT, "7cd5a6a653ba5b1b64ea39200058238092fb4acbb4cccaa874642b55cb8d2d3d"
)
WORKFLOW_DEFAULTS = Part(
    _ABSENT, "76a145570576db3b35df1420b958ba5299a75121708670ddc6c678648e840044"
)
WORKFLOW_PERMISSIONS = Part(
    _ABSENT, "e5e934acd336e53d56c56a8165524868d9a1664e77ea4af219576b09b85d29be"
)
REPO_AWARE_CONCURRENCY = Part(
    _CONCURRENCY, "6db573cfbb5b39384127ace6d10298dc13e5797adc58a64de95e1a49f3687768"
)
PYTORCH_ONLY_CONCURRENCY = Part(
    _CONCURRENCY, "77be50222a343498cd2a758883ef255dd29c7088de0c701e7bf7660ff5931c9a"
)
REVIEW_JOB = Part(
    _REVIEW_JOB, "a5e27b7013084dfe669b82898c46e084b93ad3aa46580ef2b35876db8d2bc033"
)
POLICY_CHECKOUT_STEP = Part(
    _POLICY_CHECKOUT, "a81948f1d3f0078667de5bff1f19759f34b9923dc03bac1db84b59bc7e20a7eb"
)
PYTHON_STEP = Part(
    _PYTHON, "d79ce1de2c982d133b2a2cb6bff714a8e572c2ce2acac7bc4984fb0576cb31ea"
)
UV_STEP = Part(_UV, "f9cb096a13851f61dc820b11eab297fac21407a823e2e852a216ce3eeaf5da66")
UV_ACTION = Part(
    _UV, "4cf325da87c138c6d790d4fc54730ed775644a755a027cd87826f2051f952f4d"
)
TARGET_STEP = Part(
    _TARGET, "767b0e4fa03d4e648f6a8b73fa0bf6be64d2bc5ec334570771a322bed4036d7b"
)
REPO_AWARE_CHECKOUT_STEP = Part(
    _CHECKOUT, "bcf900075fa3a5b175447e367e73243f2a0954bb3c9d9161be1c1ce1b64133d6"
)
PYTORCH_ONLY_CHECKOUT_STEP = Part(
    _CHECKOUT, "8bae4f70646f0996bc0886b0fae27ed07309434a39beeaac1159fe0bd1b25189"
)
REPO_AWARE_TRUSTED_SKILLS_STEP = Part(
    _TRUSTED_SKILLS, "45d2c5a1593b330c80b051a349280e31cb4b9f5526af96fa80099a2d137f18d7"
)
PYTORCH_ONLY_TRUSTED_SKILLS_STEP = Part(
    _TRUSTED_SKILLS, "e460fb8caa1c977c38a3001978535a0f4e6201efebecdf7cbbc2bba173d19d7c"
)
REPO_AWARE_SANITIZE_STEP = Part(
    _SANITIZE, "2507a043857a275b2701cbd53cb37563f8c1ddbba786bb8ddd83c914f1acb59f"
)
PYTORCH_ONLY_SANITIZE_STEP = Part(
    _SANITIZE, "3dca5cb950bc87519ff04b26762de0a62f1480eaae6e7d43ae6f66d9817c4aa7"
)
AWS_STEP = Part(
    _AWS, "bc60721709b65d88e176e482aedc6e9fb9b0331bbdde5fa189549917ea5d93a0"
)
REPO_AWARE_DIFF_STEP = Part(
    _DIFF, "0d7df117d9a977df2ba9462159bf75e87871ebb458600b9fd73e641731734d20"
)
PYTORCH_ONLY_DIFF_STEP = Part(
    _DIFF, "467e6e97650ffb04f64aa4a472440615af12d41dd3330b4900ff60545d44635e"
)
KEEP_POLICY_STEP = Part(
    _KEEP_POLICY, "0e2e64aa266a38993f7089c497ff60464d57c78815a2643a2b9dbf01f894add6"
)
REPO_AWARE_SIZE_GATE_STEP = Part(
    _SIZE_GATE, "eae68e0fce25d6829f7a4ff6d9e5b2a018e081a2273a837342b20d3b1b4f4535"
)
PYTORCH_ONLY_SIZE_GATE_STEP = Part(
    _SIZE_GATE, "5c395841d4a8104595775d396b95e433c07eeae41691818cb69198eabad121da"
)
DECIDE_STEP = Part(
    _DECIDE, "cfba62c390ba2bf1c83a3ca42ccdd04cbadad63a7ea7a5f55038feb90a65ab17"
)
REPO_AWARE_METADATA_STEP = Part(
    _METADATA, "18fb5b7de607e664b1aa6f0bb9734339df5e6c38d7cec11dd8cf4b0db095f4e5"
)
PYTORCH_ONLY_METADATA_STEP = Part(
    _METADATA, "fb21a66247e9b03124c8cb643463c798b7d8c2b72826bb569765a39bbe58eb11"
)
STACK_STEP = Part(
    _STACK, "de00a4a14b4e2845c890b1fa5bb69d03d509953fe68e70bc8fd569ea5b2a7e62"
)
REPO_AWARE_HOOKS_STEP = Part(
    _HOOKS, "d80d86eb370e4588473e820b962e8aca4dc331d08a59912fe2608b9815e2b737"
)
PYTORCH_ONLY_HOOKS_STEP = Part(
    _HOOKS, "2b64d67082fa4cb4e447d2ec8ea65843bcbed4f37a7d060d8cf491ca87a837b9"
)
REPO_AWARE_DEADLINES_STEP = Part(
    _DEADLINES, "5f8da8ec5afa9225988b1738adcc7bd066523a4b46543d6bce5971d517c5f65f"
)
PYTORCH_ONLY_DEADLINES_STEP = Part(
    _DEADLINES, "178d4df0e031758c38790b68a0e9b640594ceb899b925fde3b5847fd4701f237"
)
REPO_AWARE_ACTION_STEP = Part(
    _ACTION, "91e3b572bbfd6e2bd306658cf1c7eb09d29004f02b84239343e8312604a97ce7"
)
PYTORCH_ONLY_ACTION_STEP = Part(
    _ACTION, "8c86c24515375c7f35e4fd844b2e3517eb89e442d186394a163a4a10efe14d60"
)
REPO_AWARE_DETECTOR_STEP = Part(
    _DETECTOR, "b17b8fab93f9cb1f1c54768231dd7c2ee9d88cb0cfcf82053cff2284219201f1"
)
PYTORCH_ONLY_DETECTOR_STEP = Part(
    _DETECTOR, "9f167792a42401228774a35c4f35e0009eabf00cb55b12555dd455219c138929"
)
ARTIFACT_STEP = Part(
    _ARTIFACT, "3e557713a57e8b6a64b3bb88d524a07034c90615662c2e4273a2360306d8a7e4"
)
USAGE_STEP = Part(
    _USAGE, "2324847d795b47aa31fd05ae1d4eea5a49681ada1d73c7472c68ff33c8f799aa"
)
REPO_AWARE_RECORD_JOB = Part(
    _RECORD_JOB, "dd83028a0579c7b02753250c710f5f5197c9c11d5e7668250891eee136d93e9c"
)
PYTORCH_ONLY_RECORD_JOB = Part(
    _RECORD_JOB, "656d9fe7e817e5f1d0e29704b70bdaf205b770d29e5731fb52b82c50fafe6785"
)
