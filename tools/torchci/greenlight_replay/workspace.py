"""What one reviewer slot has to look like, and how it gets that way.

A pool slot is the reviewer's ``GITHUB_WORKSPACE``. ``WorktreePool`` lays out the
checkout half of it, in the directory the policy's ``greenlight target`` named; the
policy half has to be copied in beside that, and the checkout has to be stripped of
its own agent instructions before the reviewer is pointed at it. Both are done here,
per slot.

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
from collections.abc import Iterable
from pathlib import Path
from typing import TYPE_CHECKING

from torchci.greenlight_replay.checkout import PRIMARY_CHECKOUT, WorktreePool


if TYPE_CHECKING:
    from torchci.greenlight_replay.arm_code import Target


POLICY_SUBDIR = ".claude"
# restrict-read.py's allowlist beside the checkout, relative to the workspace root;
# both come from the policy tree.
POLICY_ROOTS = (".claude/skills", ".claude/hooks")
# Relative to POLICY_SUBDIR. The workflow deletes every file under it but the one
# ``greenlight target`` named before the model runs, so the reviewer reads no other
# repo's policy; directories stay.
REPO_POLICIES_SUBPATH = "skills/greenlight-review/repos"

SANITIZE_TIMEOUT_S = 600

logger = logging.getLogger(__name__)


class WorkspaceLayoutError(RuntimeError):
    """A reviewer workspace is missing one of restrict-read.py's allowed roots."""


def workspace_roots(checkout: str = PRIMARY_CHECKOUT) -> tuple[str, ...]:
    """restrict-read.py's entire allowlist, relative to the workspace root.

    The pool supplies the checkout; the policy tree supplies the rest.
    """
    return (checkout, *POLICY_ROOTS)


def install_policy_half(policy_root: Path, worktree: Path, target: Target) -> Path:
    """Copy the policy tree's ``.claude`` in beside the checkout, and check the result.

    Copied from the materialized tree rather than re-materialized, so every slot
    reviews under byte-identical policy, and copied per slot rather than shared
    because concurrent reviewers write into the workspace they are given. Under the
    per-repo policy directory only the file ``target`` names is kept, as the
    workflow's ``find -mindepth 1 ! -type d ! -path "$POLICY" -delete`` keeps it: every
    other non-directory entry at any depth goes, every directory stays. A target with
    no policy file comes from a workflow with no such step, so all of it is copied.
    """
    workspace = WorktreePool.workspace_of(worktree)
    destination = workspace / POLICY_SUBDIR
    _clear_policy_half(destination)
    source = Path(policy_root) / POLICY_SUBDIR
    repo_policies = os.path.normpath(source / REPO_POLICIES_SUBPATH)
    keep = (
        None
        if target.policy is None
        else os.path.normpath(Path(policy_root) / target.policy)
    )

    def other_repos(directory: str, names: Iterable[str]) -> set[str]:
        if keep is None or not _within(directory, repo_policies):
            return set()
        return {
            name
            for name in names
            if _is_file_like(os.path.join(directory, name))
            and os.path.normpath(os.path.join(directory, name)) != keep
        }

    shutil.copytree(source, destination, ignore=other_repos)
    check_workspace(workspace, target.checkout)
    return workspace


def _within(directory: str, root: str) -> bool:
    directory = os.path.normpath(directory)
    return directory == root or directory.startswith(root + os.sep)


def _is_file_like(path: str) -> bool:
    """What ``find ! -type d`` selects: anything but a real directory, links included."""
    return os.path.islink(path) or not os.path.isdir(path)


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
