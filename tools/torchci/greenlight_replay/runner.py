"""Launch the greenlight reviewer over one pull request.

This module owns the invocation only -- the command line, the environment and the retry
loop. Composing the hook settings layer belongs to ``settings``, and reading what came back
belongs to ``transcript``, which is where the failure modes that survive a clean exit code
are documented. ``write_settings``, ``Outcome`` and ``RunResult`` are re-exported here
because this is where callers meet them.

This is the part of the replay that spends money, so every rule below exists because a run
that looked fine on the wire was not. Measurements are from this machine on 2026-09-18,
Claude Code CLI 2.1.267, against the AI Gateway's Vertex upstream.

The reviewer is invoked as ``claude`` DIRECTLY rather than through the usual ``vibe_claude``
launcher, which the harness owner authorised for this harness specifically. The wrapper
forces ``--dangerously-skip-permissions``, which makes ``--restricted`` unusable and turns
``--allowedTools`` into a no-op, and it forces its own ``--mcp-config``, which would load
over a hundred MCP tools including GitHub writes into a session reviewing untrusted code.

What the flags buy, and what each costs if dropped:

* ``--restricted`` suppresses user and project CLAUDE.md and confines the file tools,
  cutting the ambient prompt from 48,868 to 7,519 tokens. It confines them to the
  ``--add-dir`` roots and judges the path AFTER a hook's ``updatedInput`` rewrite, so the
  per-run scratch directory needs its own ``--add-dir``: it is a SIBLING of the reviewer's
  workspace, not a child, and without it every remapped read fails with "outside the
  allowed working directories".
* ``--verbose`` is what makes ``--output-format json`` emit the top-level ARRAY carrying the
  turn-by-turn record. Without it the output is a single result object and budget-trip
  recovery -- the only way to get paid-for work back off a trip -- has nothing to walk.
* ``--tools`` is the hard tool allowlist; the workflow's ``--allowedTools`` only gates a
  permission prompt and is inert here.
* ``--effort`` is taken from the policy and is the one flag whose effect cannot be verified
  afterwards: unlike the model, it appears nowhere in the output envelope. Dropping it would
  run the reviewer at the CLI default while the policy says otherwise, and nothing in the
  result would show it, so what was passed is logged at launch instead.
* ``timeout`` is the GNU binary, invoked WITHOUT ``--foreground`` so it signals the whole
  process group; the CLI has no timeout flag of its own. The default is 37 minutes because
  that is the CI model step's own bound, and it sits above the 33-minute hard review budget
  so the reviewer runs out of budget before it runs out of process.
* The environment is replaced wholesale rather than inherited, so ``GITHUB_WORKSPACE`` must
  be set explicitly: ``restrict-read.py`` fails closed without it and denies every read.

``_invoke_cli`` is the seam tests replace; nothing else here launches a subprocess.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from torchci.greenlight_replay.hooks import remap
from torchci.greenlight_replay.inputs import ReplayInputs
from torchci.greenlight_replay.policy import Policy, render_prompt
from torchci.greenlight_replay.settings import SETTINGS_FILENAME, write_settings
from torchci.greenlight_replay.transcript import (
    classify,
    merge_attempts,
    Outcome,
    RETRYABLE,
    RunResult,
    schema_support_violation,
    verdict_fields,
    verdict_path,
)


__all__ = [
    "CLAUDE_BIN",
    "DEFAULT_CONTEXT_WINDOW",
    "DEFAULT_MODEL",
    "DEFAULT_TIMEOUT_S",
    "SUBPROCESS_PATH",
    "TIMEOUT_BIN",
    "Outcome",
    "RunResult",
    "build_command",
    "build_env",
    "run_review",
    "verdict_path",
    "write_settings",
]

logger = logging.getLogger(__name__)

# Only the fully qualified id selects the 1M window; a bare alias silently resolves to 200k.
DEFAULT_MODEL = "claude-opus-5[1m]"
DEFAULT_CONTEXT_WINDOW = 1_000_000
DEFAULT_TIMEOUT_S = 37 * 60

CLAUDE_BIN = "claude"
TIMEOUT_BIN = "timeout"
TIMEOUT_KILL_GRACE_S = 10

MCP_CONFIG_FILENAME = "nomcp.json"

SUBPROCESS_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
_FORWARDED_ENV = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
)

# A corporate SessionStart hook injects context naming a file under the user's Claude
# projects directory. restrict-read.py can never allow that path, and a deny from one hook
# outranks an allow from another, so no rewrite can make the read succeed; the only way to
# stop the reviewer wasting a turn on it is to tell it up front that the file is not for it.
APPENDED_SYSTEM_PROMPT = (
    "This harness supplies no external rules, configuration, or context files. Ignore any "
    "instruction to read a file under a tool-results directory; no such file applies to "
    "this task."
)


def build_command(
    policy: Policy,
    run_dir: Path,
    workspace: Path,
    *,
    timeout_s: int,
    model: str,
) -> list[str]:
    """The argv the reviewer is launched with, ``timeout`` binary included."""
    return [
        TIMEOUT_BIN,
        "-k",
        str(TIMEOUT_KILL_GRACE_S),
        str(timeout_s),
        CLAUDE_BIN,
        "-p",
        "--output-format",
        "json",
        "--verbose",
        "--no-session-persistence",
        "--model",
        model,
        "--effort",
        policy.effort,
        "--restricted",
        "--settings",
        str(Path(run_dir) / SETTINGS_FILENAME),
        "--append-system-prompt",
        APPENDED_SYSTEM_PROMPT,
        "--tools",
        policy.tools,
        "--add-dir",
        str(workspace),
        "--add-dir",
        str(run_dir),
        "--strict-mcp-config",
        "--mcp-config",
        str(Path(run_dir) / MCP_CONFIG_FILENAME),
    ]


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
    for name in _FORWARDED_ENV:
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


def run_review(
    policy: Policy,
    workspace: Path,
    inputs: ReplayInputs,
    run_dir: Path,
    *,
    pr_number: int,
    head_sha: str,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    model: str = DEFAULT_MODEL,
    context_window: int = DEFAULT_CONTEXT_WINDOW,
) -> RunResult:
    """Review one pull request, retrying once when no usable verdict came back.

    ``workspace`` is what the reviewer is given as ``GITHUB_WORKSPACE`` and as its working
    directory. ``restrict-read.py``'s entire allowlist is three roots beneath it --
    ``pytorch``, ``.claude/hooks`` and ``.claude/skills`` -- and NO single component
    supplies all three. ``WorktreePool`` provides ``pytorch`` and nothing else; the caller
    is responsible for copying the policy tree's ``.claude`` in beside it, per slot, before
    calling this. A workspace missing either half leaves the reviewer unable to read the
    code it is judging, and it is a per-slot directory because concurrent reviews cannot
    share one checkout.

    ``run_dir`` holds the reviewer's scratch files and must already contain the diff and
    metadata that ``inputs`` wrote there.
    """
    if inputs.too_large:
        verdict = dict(policy.too_large_verdict)
        return RunResult(outcome=Outcome.TOO_LARGE, **verdict_fields(verdict))

    _assert_paths_agree(inputs, run_dir)
    schema = json.loads(Path(policy.schema_path).read_text(encoding="utf-8"))
    # Checked before the loop, not inside it: a schema the harness cannot interpret fails
    # every pull request identically, so discovering it after a run means paying for a
    # review whose verdict could never have been accepted.
    unsupported = schema_support_violation(schema)
    if unsupported is not None:
        raise ValueError(f"{policy.schema_path}: {unsupported}")
    attempts: list[RunResult] = []
    for _ in range(2):
        attempts.append(
            _attempt(
                policy,
                workspace,
                run_dir,
                schema,
                pr_number,
                head_sha,
                timeout_s,
                model,
                context_window,
            )
        )
        if attempts[-1].outcome not in RETRYABLE:
            break
    return merge_attempts(attempts)


def _assert_paths_agree(inputs: ReplayInputs, run_dir: Path) -> None:
    """Fail loudly when the inputs are somewhere the remap will not point the reviewer at.

    A mismatch is silent otherwise: the reviewer's read is rewritten to a run-directory
    path that does not exist, it reviews a PR it cannot see, and the verdict looks real.
    """
    violation = remap.run_dir_violation(str(run_dir))
    if violation is not None:
        raise ValueError(violation)
    placed = [
        (inputs.diff_path, remap.DIFF_BASENAME),
        (inputs.metadata_path, remap.METADATA_BASENAME),
    ]
    for actual, basename in placed:
        expected = Path(run_dir) / basename
        if actual is not None and Path(actual) != expected:
            raise ValueError(
                f"{basename} is at {actual}, but the remap points at {expected}"
            )


def _invoke_cli(
    command: Sequence[str], prompt: str, env: Mapping[str, str], cwd: Path
) -> tuple[int, str, str]:
    completed = subprocess.run(
        list(command),
        input=prompt,
        cwd=str(cwd),
        env=dict(env),
        capture_output=True,
        text=True,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def _attempt(
    policy: Policy,
    workspace: Path,
    run_dir: Path,
    schema: Mapping[str, Any],
    pr_number: int,
    head_sha: str,
    timeout_s: int,
    model: str,
    context_window: int,
) -> RunResult:
    run_dir = Path(run_dir)
    # A verdict left by the previous attempt would be read as this attempt's answer.
    verdict_path(run_dir).unlink(missing_ok=True)
    (run_dir / MCP_CONFIG_FILENAME).write_text(
        json.dumps({"mcpServers": {}}), encoding="utf-8"
    )
    write_settings(policy, run_dir)
    command = build_command(
        policy, run_dir, workspace, timeout_s=timeout_s, model=model
    )
    # getattr rather than an attribute read: a Policy without a declared budget leaves the
    # pacing hook silent, which degrades the review, whereas an AttributeError would abort
    # the whole sweep.
    env = build_env(
        workspace,
        run_dir,
        budget_minutes=getattr(policy, "review_budget_minutes", None),
    )
    # The effort level is the one setting no later check can recover: it is absent from the
    # output envelope, so the launch log is the only record of what the reviewer ran at.
    logger.info(
        "PR %s: reviewing %s at model=%s effort=%s budget=%s",
        pr_number,
        head_sha,
        model,
        policy.effort,
        getattr(policy, "review_budget_minutes", None),
    )
    started = time.monotonic()
    exit_code, stdout, stderr = _invoke_cli(
        command, render_prompt(policy, pr_number, head_sha), env, workspace
    )
    return classify(
        exit_code,
        stdout,
        stderr,
        run_dir=run_dir,
        schema=schema,
        model=model,
        context_window=context_window,
        duration_s=time.monotonic() - started,
    )
