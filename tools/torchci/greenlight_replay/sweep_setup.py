"""Opening a sweep: the policy, the shared clone, the trusted tree and the staging.

``open_sweep`` builds the :class:`Sweep` that ``sweep.run_sweep`` drives the
sampled rows through, and ``prepare_policy`` holds the checks a dry run makes
too. Every fault found here is a property of the policy or of the repo rather
than of any pull request, so it stops the sweep before anything is spent.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path

from torchci.greenlight_replay.checkout import clone_url, require_repo, WorktreePool
from torchci.greenlight_replay.policy import materialize as materialize_policy, Policy
from torchci.greenlight_replay.preflight import preflight
from torchci.greenlight_replay.runner import bedrock_enabled, DEFAULT_MODEL
from torchci.greenlight_replay.settings import assert_hooks_present
from torchci.greenlight_replay.trusted_skills import materialize_trusted_skills
from torchci.greenlight_replay.workspace import stage_policy_half


POLICY_DIRNAME = "policy"
# Per repo, so a shared workdir never restores one repo's skills into another's, and
# per commit when pinned, so a tree checked out at one commit is never reused at another.
BARE_CLONE_DIRNAME = "{}.git"
TRUSTED_MAIN_DIRNAME = "{}-main-trusted"
TRUSTED_PINNED_DIRNAME = "{}-trusted-{}"
# The policy's .claude with the repo's policy staged into it, which every slot copies.
STAGED_POLICY_DIRNAME = "staged-policy"

# The workflow names a Bedrock inference profile and a CLI off Bedrock names a
# model, so off Bedrock the profile is translated into a model. Mapped rather than
# defaulted: a policy pull request that switches models would otherwise replay
# silently on the model it replaced and read as a clean sweep of the new policy.
LOCAL_MODELS = {"global.anthropic.claude-opus-5": DEFAULT_MODEL}

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Sweep:
    """Everything one re-review needs that does not vary between pull requests.

    ``policy_source`` is the tree each slot's ``.claude`` is copied from, and
    ``staged`` whether the policy tree's ``repo-policy.py`` staged the repo's policy.
    """

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
    policy_source: Path
    staged: bool
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
    timeout_s: int | None,
    model: str | None,
    context_window: int,
    interrupted: threading.Event,
    trusted_ref: str | None = None,
) -> Sweep:
    """Materialize the policy and the trusted tree, stage, and clone the repo.

    ``model`` overrides what the policy's own inference profile maps to; without
    one an unrecognised profile stops a sweep off Bedrock here, before the clone
    and before anything is spent. ``trusted_ref`` pins the trusted tree to one
    commit of the repo; without it the tree is the repo's ``main``. ``timeout_s``
    None is the policy's own. A repo that gets no staged policy declines every pull
    request unread, so it is not cloned.
    """
    name = require_repo(repo).partition("/")[2]
    preflight(workdir, policy_ref)
    policy, model = prepare_policy(policy_ref, workdir, model, repo)
    pool = WorktreePool(
        workdir / BARE_CLONE_DIRNAME.format(name),
        parallelism,
        repo_url=clone_url(repo),
        dirname=policy.target.checkout,
    )
    trusted_dirname = (
        TRUSTED_PINNED_DIRNAME.format(name, trusted_ref)
        if trusted_ref
        else TRUSTED_MAIN_DIRNAME.format(name)
    )
    trusted = materialize_trusted_skills(
        workdir / trusted_dirname, repo_url=clone_url(repo), sha=trusted_ref
    )
    policy_source, staged = stage_policy_half(
        policy, repo, trusted, workdir / STAGED_POLICY_DIRNAME
    )
    if staged:
        pool.ensure_clone()
    else:
        logger.warning(
            "no review policy was staged for %s, so every pull request gets the "
            "workflow's canned review_error verdict and no model runs",
            repo,
        )
    return Sweep(
        policy=policy,
        pool=pool,
        trusted_skills=trusted,
        model=model,
        context_window=context_window,
        workdir=workdir,
        checkpoint_path=checkpoint_path,
        repo=repo,
        timeout_s=policy.timeout_s if timeout_s is None else timeout_s,
        interrupted=interrupted,
        policy_source=policy_source,
        staged=staged,
    )


def prepare_policy(
    policy_ref: str, workdir: Path, model: str | None, repo: str
) -> tuple[Policy, str]:
    """Materialize the policy for ``repo`` and refuse anything a sweep cannot survive.

    Every fault found here is a property of the policy rather than of any pull
    request, so each would otherwise fail every review in the sweep identically.
    Safe to run twice: ``materialize`` clears its destination and re-extracts, so
    a dry run doing this does not spoil the real run that follows it.
    """
    policy = materialize_policy(
        policy_ref, workdir / POLICY_DIRNAME, reviewed_repo=repo
    )
    # A hook that cannot exec does not deny, it silently does not run.
    assert_hooks_present(policy)
    model = model or local_model(policy.model)
    logger.info(
        "policy %s asks for %s; running %s locally", policy_ref, policy.model, model
    )
    return policy, model


def local_model(profile: str) -> str:
    """The local CLI's name for the Bedrock inference profile the policy asks for.

    On Claude Code's Bedrock provider (``runner.bedrock_enabled``) the profile is
    itself the model id the CLI takes, so it passes through unchanged. Anywhere
    else it is mapped, and raises rather than falling back. The runner asserts
    that the model which answered is the one it asked for, so a profile passed
    through to another backend fails every run; a profile quietly replaced by
    the default reviews the new policy on the old policy's model and reads as a
    clean sweep, which is worse.
    """
    if bedrock_enabled():
        return profile
    try:
        return LOCAL_MODELS[profile]
    except KeyError:
        raise ValueError(
            f"the policy asks for {profile!r}; this harness maps only "
            f"{', '.join(sorted(LOCAL_MODELS))}. Pass --model to name one"
        ) from None
