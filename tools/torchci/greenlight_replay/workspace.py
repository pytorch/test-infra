"""What one reviewer slot has to look like, and how it gets that way.

A pool slot is the reviewer's ``GITHUB_WORKSPACE``. ``WorktreePool`` lays out the
checkout half of it, in the directory the policy's ``greenlight target`` named; the
policy half has to be copied in beside that, and the checkout has to be stripped of
its own agent instructions before the reviewer is pointed at it. Both are done here,
per slot.

A policy tree with ``repo-policy.py`` decides, as the workflow does, which repo
policy the slots hold and whether the model runs at all: ``stage_policy_half``
stages the reviewed repo's policy into the copy every slot is made from, and
``touches_verdict`` runs its diff gate.

Getting either wrong is quiet rather than loud: the reviewer's reads are denied
one at a time and it answers anyway, from less than the pull request, or -- if
the skill is what went missing -- without anything telling it how to review at
all.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path

from torchci.greenlight_replay.arm_code import run_script
from torchci.greenlight_replay.checkout import PRIMARY_CHECKOUT, WorktreePool
from torchci.greenlight_replay.policy import Policy


POLICY_SUBDIR = ".claude"
# restrict-read.py's allowlist beside the checkout, relative to the workspace root;
# both come from the policy tree.
POLICY_ROOTS = (".claude/skills", ".claude/hooks")

SANITIZE_TIMEOUT_S = 600

# The workflow reads anything but exactly these lines as staged=false and touches=true.
STAGED_LINE = "staged=true"
UNTOUCHED_LINE = "touches=false"

logger = logging.getLogger(__name__)


class WorkspaceLayoutError(RuntimeError):
    """A reviewer workspace is missing one of restrict-read.py's allowed roots."""


def workspace_roots(checkout: str = PRIMARY_CHECKOUT) -> tuple[str, ...]:
    """restrict-read.py's entire allowlist, relative to the workspace root.

    The pool supplies the checkout; the policy tree supplies the rest.
    """
    return (checkout, *POLICY_ROOTS)


def stage_policy_half(
    policy: Policy, repo: str, trusted_checkout: Path, staged_root: Path
) -> tuple[Path, bool]:
    """The tree every slot's ``.claude`` is copied from, and whether a policy was staged.

    A policy tree without ``repo-policy.py`` is that tree itself, staged. Otherwise its
    ``.claude`` is copied under ``staged_root`` once and the script's ``stage`` run on
    the copy, with the workflow's arguments: the repo, the trusted checkout of the
    repo, and the ``.claude`` it stages into. Once rather than per slot because the
    outcome depends on none of them, and a declined row never takes a slot yet still
    gets ``staged=false``'s verdict. The script exits 0 on every policy outcome; any
    other exit fails the job in CI and raises here.
    """
    script = policy.repo_policy_script
    if script is None:
        return Path(policy.root), True
    destination = Path(staged_root) / POLICY_SUBDIR
    _clear_policy_half(destination)
    shutil.copytree(Path(policy.root) / POLICY_SUBDIR, destination)
    output = _run_repo_policy(
        script,
        [
            "stage",
            repo,
            os.path.abspath(trusted_checkout),
            os.path.abspath(destination),
        ],
    )
    staged = output == STAGED_LINE
    logger.info("repo-policy.py staged %s's policy: %s", repo, output or "(nothing)")
    return Path(staged_root), staged


def touches_verdict(policy: Policy, diff_path: Path) -> dict[str, str] | None:
    """The tree's canned verdict for a diff touching the repo's ``.github/greenlight``.

    ``None`` when the diff does not, and always for a tree without ``repo-policy.py``.
    """
    script = policy.repo_policy_script
    if script is None:
        return None
    if (
        _run_repo_policy(script, ["touches", os.path.abspath(diff_path)])
        == UNTOUCHED_LINE
    ):
        return None
    if policy.greenlight_files_verdict is None:
        raise ValueError(f"{script} has no canned verdict for the diff gate beside it")
    return dict(policy.greenlight_files_verdict)


def _run_repo_policy(script: Path, args: Sequence[str]) -> str:
    """Run ``repo-policy.py`` with ``args`` as the arm's code runs, and return its one
    line of output."""
    completed = run_script(script, *args)
    stderr = completed.stderr.strip()
    if completed.returncode != 0:
        raise RuntimeError(
            f"repo-policy.py {args[0]} exited {completed.returncode}: {stderr[:400]}"
        )
    if stderr:
        logger.info("repo-policy.py %s: %s", args[0], stderr[:400])
    return completed.stdout.rstrip("\n")


def install_policy_half(
    policy_root: Path, worktree: Path, checkout: str = PRIMARY_CHECKOUT
) -> Path:
    """Copy ``policy_root``'s ``.claude`` in beside the checkout, and check the result.

    Copied from one tree rather than re-materialized, so every slot reviews under
    byte-identical policy, and copied per slot rather than shared because concurrent
    reviewers write into the workspace they are given. ``policy_root`` is what
    ``stage_policy_half`` returned.
    """
    workspace = WorktreePool.workspace_of(worktree)
    destination = workspace / POLICY_SUBDIR
    _clear_policy_half(destination)
    shutil.copytree(Path(policy_root) / POLICY_SUBDIR, destination)
    check_workspace(workspace, checkout)
    return workspace


def _clear_policy_half(destination: Path) -> None:
    """Remove a previous sweep's copy so a file the new policy deleted cannot survive.

    Overlaying instead would leave exactly what this harness exists to catch: a
    hook or skill the policy under test removed, still being read. The removal is
    narrow rather than trusting -- it takes only a real directory named
    ``.claude`` that holds no ``.git``, since a ``.git`` means the path is
    somebody's checkout rather than a copy this module made, and a symlink could
    aim the removal somewhere else entirely.
    """
    if destination.is_symlink():
        raise ValueError(f"refusing to remove {destination}: it is a symlink")
    if not destination.exists():
        return
    if destination.name != POLICY_SUBDIR or not destination.is_dir():
        raise ValueError(
            f"refusing to remove {destination}: not a {POLICY_SUBDIR} tree"
        )
    if (destination / ".git").exists():
        raise ValueError(f"refusing to remove {destination}: it holds a .git")
    shutil.rmtree(destination)


def check_workspace(workspace: Path, checkout: str = PRIMARY_CHECKOUT) -> None:
    """Refuse a workspace whose layout would silently starve the reviewer.

    Handed the checkout the other way round -- the reviewed tree at the root, or
    the policy half missing -- the reads the prompt depends on are denied one by
    one, and the run still exits clean with a verdict formed from no code.
    """
    roots = workspace_roots(checkout)
    missing = [root for root in roots if not (workspace / root).is_dir()]
    if missing:
        raise WorkspaceLayoutError(
            f"{workspace} is missing {', '.join(missing)}; a reviewer workspace "
            f"holds the checkout at {roots[0]} and the policy's .claude beside it"
        )


def sanitize_checkout(script: Path, worktree: Path, trusted_skills: Path) -> None:
    """Strip the reviewed checkout's own agent instructions before the model sees it.

    A pull request can carry a CLAUDE.md or a .claude tree of its own, and the
    reviewer would read them as instructions about the review. The script takes
    two arguments and exits 1 given one; the second comes from the reviewed repo's
    main rather than from the policy tree, which would plant greenlight's own
    reviewer skill inside the code under review.
    """
    completed = subprocess.run(
        [str(script), str(worktree), str(trusted_skills)],
        capture_output=True,
        check=False,
        timeout=SANITIZE_TIMEOUT_S,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"sanitizing {worktree} exited {completed.returncode}: {stderr[:400]}"
        )
