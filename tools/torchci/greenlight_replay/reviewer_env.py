"""Compose the reviewer's environment.

The CLI is launched with the mapping ``build_env`` returns and nothing else: the
operator's environment is replaced, not extended, so a variable reaches the reviewer only
when it is named here. ``runner`` launches the reviewer with it.
"""

from __future__ import annotations

import os
import time
from collections.abc import Sequence
from pathlib import Path

from torchci.greenlight_replay.hooks import remap


__all__ = [
    "BEDROCK_SWITCH",
    "SUBPROCESS_PATH",
    "bedrock_enabled",
    "build_env",
]

SUBPROCESS_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
_FORWARDED_ENV = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
)
BEDROCK_SWITCH = "CLAUDE_CODE_USE_BEDROCK"


def bedrock_enabled() -> bool:
    """Whether the operator put the reviewer on Claude Code's Bedrock provider."""
    return os.environ.get(BEDROCK_SWITCH, "").strip().lower() in ("1", "true")


def build_env(
    workspace: Path,
    run_dir: Path,
    *,
    budget_minutes: Sequence[int] | None = None,
    now: float | None = None,
) -> dict[str, str]:
    """The reviewer's entire environment. Nothing absent from here reaches it.

    ``budget_minutes`` is the policy's (target, soft, hard) triple, turned into the absolute
    epochs ``budget-reminder.sh`` reads. Those reminders are not decoration: the reviewer has
    no Bash and therefore no clock, the skill's Time budget section tells it the reminders
    are its only signal of elapsed time, and the last tier restates the decision rule. Left
    unset the hook stays silent -- its documented behaviour for a run with no budget -- and
    the reviewer paces itself against nothing while the skill claims otherwise.

    Under ``bedrock_enabled`` the CLI gets ``AWS_REGION`` and the switch as ``1``, so it and
    the harness agree on the provider. Credentials never follow: a sweep can outlive its AWS
    session, and a key passed here would shadow ``~/.aws``, which each new reviewer rereads.
    """
    env = {
        "HOME": os.environ.get("HOME", ""),
        "PATH": SUBPROCESS_PATH,
        "TERM": "dumb",
        # restrict-read.py denies every read when this is unset.
        "GITHUB_WORKSPACE": str(workspace),
        remap.RUN_DIR_ENV: str(run_dir),
        # RUNNER_TEMP alone: it moves budget-reminder.sh's rate-limit state file off the
        # shared /tmp, which concurrent runs would otherwise fight over.
        #
        # GREENLIGHT_REVIEW_VERDICT_FILE is deliberately NOT set, even though the hook
        # honours it. Its tier-4 text quotes the path back to the model ("the verdict is
        # due now at ..."), and the reviewer is not permitted to write anywhere but the
        # literal /tmp/greenlight-verdict.json: restrict-write.sh compares that exact
        # string and remap.py rewrites only that exact string. Pointing the hook at the
        # run directory would therefore hand the model, at the hard deadline, a path
        # contradicting both the prompt and the skill's "EXACTLY" -- and obeying it costs
        # a blocked write and a turn it no longer has. Left unset the hook quotes the CI
        # path, which is the one that works; the price is that its existence probe never
        # sees the verdict, so tier 4 keeps nagging after the verdict is written. A
        # redundant nag past 33 minutes is cheaper than a blocked write at the deadline.
        "RUNNER_TEMP": str(run_dir),
    }
    bedrock = bedrock_enabled()
    if bedrock:
        env[BEDROCK_SWITCH] = "1"
    for name in _FORWARDED_ENV + (("AWS_REGION",) if bedrock else ()):
        value = os.environ.get(name)
        if value:
            env[name] = value
    if budget_minutes:
        target, soft, hard = (int(minutes) for minutes in budget_minutes)
        start = int(now if now is not None else time.time())
        env.update(
            {
                "GREENLIGHT_REVIEW_START_EPOCH": str(start),
                "GREENLIGHT_REVIEW_TARGET_DEADLINE": str(start + target * 60),
                "GREENLIGHT_REVIEW_SOFT_DEADLINE": str(start + soft * 60),
                "GREENLIGHT_REVIEW_HARD_DEADLINE": str(start + hard * 60),
            }
        )
    return env
