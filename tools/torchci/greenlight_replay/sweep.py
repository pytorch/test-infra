"""Running the sampled pull requests: the slot pool, the workspaces, the fan-out.

Everything one sweep needs that does not depend on argv. ``open_sweep`` builds
the state a run draws on -- the policy tree, the shared clone, the trusted
skills -- and ``run_sweep`` drives the sampled rows through it, recording each
finished pull request in the checkpoint as it goes.

A pool slot is the reviewer's ``GITHUB_WORKSPACE``, and what one has to hold for
the reviewer to read anything is ``workspace``'s subject rather than this
module's. What is decided here is the order: which checks are worth making
before the network is touched, and when a fault on one pull request means the
remaining ones are not worth paying for.
"""

from __future__ import annotations

import contextlib
import json
import logging
import signal
import threading
from collections.abc import Iterator, Mapping, Sequence
from concurrent.futures import as_completed, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from torchci.greenlight_decisions.__main__ import parse_as_of
from torchci.greenlight_replay.checkout import materialize_trusted_skills, WorktreePool
from torchci.greenlight_replay.emit import append_checkpoint
from torchci.greenlight_replay.inputs import build_inputs
from torchci.greenlight_replay.policy import materialize as materialize_policy, Policy
from torchci.greenlight_replay.preflight import preflight
from torchci.greenlight_replay.runner import (
    DEFAULT_MODEL,
    Outcome,
    run_review,
    RunResult,
    schema_support_violation,
)
from torchci.greenlight_replay.settings import assert_hooks_present
from torchci.greenlight_replay.workspace import install_policy_half, sanitize_checkout


# A run directory is passed to the reviewer as its own ``--add-dir``, and
# ``--restricted`` confines the file tools to those roots. That only isolates one
# run from another while the run directory is a SIBLING of the workspace rather
# than a child -- adding the workspace would otherwise cover every run directory
# beneath it at once. restrict-read.py does not help: it allows anything under
# the /tmp/greenlight- prefix, other pull requests' run directories included.
POLICY_DIRNAME = "policy"
BARE_CLONE_DIRNAME = "pytorch.git"
TRUSTED_SKILLS_DIRNAME = "pytorch-main-skills"
RUNS_DIRNAME = "runs"

# The workflow names a Bedrock inference profile and the local CLI names a
# model, so one has to be translated into the other. Mapped rather than
# defaulted: a policy pull request that switches models would otherwise replay
# silently on the model it replaced and read as a clean sweep of the new policy.
LOCAL_MODELS = {"global.anthropic.claude-opus-5": DEFAULT_MODEL}

# Outcomes the warm-up cannot recover from, because none of them depends on
# which pull request was reviewed: the model the gateway resolved, the schema the
# policy ships, the prompt the CLI parsed. Seeing one on the first run means
# seeing it on every run, so the sweep stops rather than paying for the rest.
# Deliberately wider than the runner's own RETRYABLE, which asks whether one more
# attempt on THIS pull request could help; this asks whether the next thirty
# could.
FATAL_OUTCOMES = frozenset(
    {Outcome.API_ERROR, Outcome.SCHEMA_INVALID, Outcome.EMPTY_RUN}
)

# Measured over 872 real CI reviewer runs: 9-11 minutes and $1.33 apiece.
ESTIMATED_COST_USD = 1.33
ESTIMATED_MINUTES = 10.0

# Above this share of attempted runs reaching no verdict, the new columns
# describe the harness rather than the policy, and that has to show in the exit
# status. Mirrors the decision export's LOC_FAILURE_ABORT_RATIO.
RUN_FAILURE_ABORT_RATIO = 0.5

logger = logging.getLogger(__name__)


class SweepAborted(RuntimeError):
    """The warm-up run failed in a way every remaining run would repeat."""


@dataclass(frozen=True)
class Sweep:
    """Everything one re-review needs that does not vary between pull requests."""

    policy: Policy
    pool: WorktreePool
    trusted_skills: Path
    model: str
    context_window: int
    workdir: Path
    checkpoint_path: Path
    repo: str
    timeout_s: int
    interrupted: threading.Event
    checkpoint_lock: threading.Lock = field(default_factory=threading.Lock)
    workspace_lock: threading.Lock = field(default_factory=threading.Lock)
    prepared: set[Path] = field(default_factory=set)
    # A list, not a mapping by number: a row whose number cell will not parse is
    # itself one of the failures here, so there is no key and two must not merge.
    errors: list[tuple[str, str]] = field(default_factory=list)


def open_sweep(
    *,
    policy_ref: str,
    workdir: Path,
    checkpoint_path: Path,
    repo: str,
    parallelism: int,
    timeout_s: int,
    model: str | None,
    context_window: int,
    interrupted: threading.Event,
) -> Sweep:
    """Materialize the policy, the shared clone and the trusted skills tree.

    ``model`` overrides what the policy's own inference profile maps to; without
    one an unrecognised profile stops the sweep here, before the clone and
    before anything is spent.
    """
    preflight(workdir, policy_ref)
    policy = materialize_policy(policy_ref, workdir / POLICY_DIRNAME)
    check_schema(policy)
    # A hook that cannot exec does not deny, it silently does not run.
    assert_hooks_present(policy)
    model = model or local_model(policy.model)
    logger.info(
        "policy %s asks for %s; running %s locally", policy_ref, policy.model, model
    )
    pool = WorktreePool(
        workdir / BARE_CLONE_DIRNAME,
        parallelism,
        repo_url=f"https://github.com/{repo}.git",
    )
    pool.ensure_clone()
    return Sweep(
        policy=policy,
        pool=pool,
        trusted_skills=materialize_trusted_skills(workdir / TRUSTED_SKILLS_DIRNAME),
        model=model,
        context_window=context_window,
        workdir=workdir,
        checkpoint_path=checkpoint_path,
        repo=repo,
        timeout_s=timeout_s,
        interrupted=interrupted,
    )


def local_model(profile: str) -> str:
    """The local CLI's name for the Bedrock inference profile the policy asks for.

    Raises rather than falling back. The runner asserts that the model which
    answered is the one it asked for, so a profile passed through verbatim fails
    every run; a profile quietly replaced by the default reviews the new policy
    on the old policy's model and reads as a clean sweep, which is worse.
    """
    try:
        return LOCAL_MODELS[profile]
    except KeyError:
        raise ValueError(
            f"the policy asks for {profile!r}; this harness maps only "
            f"{', '.join(sorted(LOCAL_MODELS))}. Pass --model to name one"
        ) from None


def check_schema(policy: Policy) -> None:
    """Refuse a verdict schema the runner could not read or could not interpret.

    Both are properties of the policy rather than of any pull request, so either
    fails every review in the sweep identically -- and a keyword the validator
    does not implement fails them twice, since each gets retried first. Checked
    once here instead, before anything is spent.
    """
    try:
        schema = json.loads(Path(policy.schema_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{policy.schema_path} is not readable JSON: {exc}") from exc
    unsupported = schema_support_violation(schema)
    if unsupported is not None:
        raise ValueError(f"{policy.schema_path} cannot be interpreted: {unsupported}")


def run_sweep(
    sweep: Sweep, pending: Sequence[Mapping[str, str]], parallelism: int
) -> None:
    """Warm the prompt cache with one serial run, then fan the rest out.

    Concurrent cold starts each pay the whole prompt in; one run first puts it in
    the cache and every later slot reads it back at a fraction of the price.
    """
    if not pending:
        logger.info("nothing to run")
        return
    logger.info("warming the prompt cache on PR %s", pending[0].get("pr_number"))
    outcome = run_one(sweep, pending[0])
    rest = pending[1:]
    if outcome is not None and outcome in FATAL_OUTCOMES:
        raise SweepAborted(
            f"the warm-up run on PR {pending[0].get('pr_number')} ended in "
            f"{outcome.value}, which does not depend on which pull request was "
            f"reviewed; stopping before the remaining {len(rest)} runs bill "
            f"about ${len(rest) * ESTIMATED_COST_USD:.0f}"
        )
    if not rest:
        return
    logger.info(
        "re-reviewing %d pull requests at parallelism %d", len(rest), parallelism
    )
    with ThreadPoolExecutor(max_workers=parallelism) as executor:
        futures = [executor.submit(run_one, sweep, row) for row in rest]
        try:
            for done, future in enumerate(as_completed(futures), start=1):
                future.result()
                logger.info("%d/%d complete", done, len(rest))
        except BaseException:
            # Leaving this block runs shutdown(wait=True), which would otherwise
            # let every queued review start and bill in full on the way out,
            # after the reason to stop was known. Cancelling is not enough on its
            # own: a review already running has to be told as well.
            sweep.interrupted.set()
            for queued in futures:
                queued.cancel()
            raise


def run_one(sweep: Sweep, row: Mapping[str, str]) -> Outcome | None:
    """Re-review one pull request, returning how it ended.

    Never raises, and that is load-bearing: this runs on a thread pool whose
    executor bills every queued review on its way out, so an escape here costs
    money. Everything from reading the row's number to appending the checkpoint
    is inside the guard; a failure is recorded and reported as ``None``, which is
    distinct from every outcome a run can reach.
    """
    if sweep.interrupted.is_set():
        return None
    label = str(row.get("pr_number"))
    try:
        number = pr_number(row)
        head_sha = row["decision_head_sha"]
        run_dir = sweep.workdir / RUNS_DIRNAME / str(number)
        run_dir.mkdir(parents=True, exist_ok=True)
        replay_inputs = build_inputs(
            sweep.repo,
            number,
            row["base_ref"],
            head_sha,
            parse_as_of(row["decision_version"]),
            run_dir,
            sweep.policy,
        )

        def review(workspace: Path) -> RunResult:
            return run_review(
                sweep.policy,
                workspace,
                replay_inputs,
                run_dir,
                pr_number=number,
                head_sha=head_sha,
                timeout_s=sweep.timeout_s,
                model=sweep.model,
                context_window=sweep.context_window,
            )

        if replay_inputs.too_large:
            # The size gate declined: no reviewer runs, so no slot, blob fetch or
            # clean walk is spent reaching the canned verdict. run_review returns
            # before reading the workspace here, so one never acquired can be named.
            result = review(sweep.policy.root)
        else:
            with sweep.pool.checkout(head_sha, pr_number=number) as worktree:
                # Refusing a bad layout is free; sanitize is a subprocess.
                workspace = prepare_workspace(sweep, worktree)
                sanitize_checkout(
                    sweep.policy.sanitize_script, worktree, sweep.trusted_skills
                )
                result = review(workspace)
        with sweep.checkpoint_lock:
            append_checkpoint(sweep.checkpoint_path, row, result)
    except Exception as exc:
        logger.error("PR %s never reached a verdict: %s", label, exc, exc_info=True)
        sweep.errors.append((label, type(exc).__name__))
        return None
    return result.outcome


def prepare_workspace(sweep: Sweep, worktree: Path) -> Path:
    """The reviewer's workspace for one worktree, built once per slot.

    Slots are reused across pull requests, so the policy half is installed the
    first time a slot is seen and left alone afterwards; the pool's own reset
    cleans the checkout beside it without touching this.
    """
    workspace = WorktreePool.workspace_of(worktree)
    with sweep.workspace_lock:
        if workspace not in sweep.prepared:
            install_policy_half(sweep.policy.root, worktree)
            sweep.prepared.add(workspace)
    return workspace


@contextlib.contextmanager
def interrupt_guard() -> Iterator[threading.Event]:
    """Turn the first SIGINT into a stop flag so the checkpoint still becomes a CSV.

    The default handler goes back in place as the flag is set, so a second Ctrl-C
    kills the sweep outright rather than waiting on an in-flight reviewer that
    can hold the process for another half hour.
    """
    interrupted = threading.Event()

    def handle(signum: int, frame: Any) -> None:
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        interrupted.set()
        logger.warning(
            "interrupted; finishing the in-flight runs, then writing what is "
            "checkpointed. Ctrl-C again to stop now"
        )

    previous = signal.signal(signal.SIGINT, handle)
    try:
        yield interrupted
    finally:
        signal.signal(signal.SIGINT, previous)


def runs_are_trustworthy(
    results: Mapping[int, Mapping[str, str]], errors: Mapping[int, str]
) -> bool:
    """Whether enough runs reached a verdict for the new columns to mean anything.

    One awkward pull request degrades one row and is expected. The gateway being
    down degrades every row while the file still looks like a replay, so that
    case has to be visible in the exit status.
    """
    attempted = len(results) + len(errors)
    if not attempted:
        return True
    failed = len(errors) + sum(
        1 for entry in results.values() if not entry.get("new_decision")
    )
    return failed / attempted <= RUN_FAILURE_ABORT_RATIO


def pr_number(row: Mapping[str, Any]) -> int:
    return int(row["pr_number"])
