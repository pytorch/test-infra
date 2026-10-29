"""Check out the trusted skills tree the sanitize step restores from.

``materialize_trusted_skills`` makes the second argument of
``sanitize-untrusted-checkout.sh``: a sparse checkout of pytorch ``main`` whose cone is
``.claude/skills``. Its git calls go through ``checkout``'s confined helpers.
"""

from __future__ import annotations

from pathlib import Path

from torchci.greenlight_replay.checkout import (
    _git,
    _require_url,
    GitError,
    PYTORCH_REPO_URL,
)


__all__ = ["materialize_trusted_skills"]

TRUSTED_SKILLS_SUBPATH = ".claude/skills"


def materialize_trusted_skills(
    dest: Path,
    *,
    repo_url: str = PYTORCH_REPO_URL,
    ref: str = "main",
) -> Path:
    """Check out pytorch ``main``'s ``.claude/skills`` once, for the sanitize step.

    ``sanitize-untrusted-checkout.sh`` takes TWO required arguments -- the untrusted
    checkout and a directory to restore trusted skills FROM -- and exits 1 when given one.
    CI supplies the second from a separate sparse checkout of pytorch main, and this is the
    local equivalent. The second argument must never point at the policy tree: that would
    copy greenlight's own reviewer skill into the tree being reviewed.

    ``.claude/skills`` can be a symlink whose target lies outside the cone. CI's checkout
    sets the cone before anything is checked out, so git never vets that path and the link
    arrives dangling, which the sanitize step reads as no skills to restore. Cone mode
    refuses a path the index already holds as a file, so ``--skip-checks`` is what gives
    the same result here. CI's checkout succeeds whatever main holds at that path -- a
    directory, a link, a file or nothing -- and so does this one; a later call recognizes
    it by its cone, which a half-finished clone never got, and by a tree still matching
    its commit.

    Returns ``dest``, the directory to pass as the sanitize script's second argument.
    """
    _require_url(repo_url)
    dest = dest.resolve()
    skills = dest / TRUSTED_SKILLS_SUBPATH
    if skills.is_dir() or skills.is_symlink():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The PARENT of the directory git is asked to work in. A ceiling equal to the process
    # working directory is ignored outright, so `ceiling=dest.parent` while cloning FROM
    # dest.parent confines nothing.
    ceiling = dest.parent.parent
    if (dest / ".git").exists():
        if _finished(dest, ceiling):
            return dest
        # Loud rather than silent, and deliberately the same stance policy._clear_destination
        # takes: any other .git here is a half-finished clone whose cone was never set --
        # which a silent skip would make permanent, since the guard would keep seeing .git
        # and never re-clone -- a checkout changed since, or somebody's real checkout, which
        # must not be written into either way.
        raise GitError(
            f"{dest} already holds a .git but no {TRUSTED_SKILLS_SUBPATH}; it is a "
            "half-finished clone, a changed checkout or a real one. Remove it and re-run."
        )
    _git(
        [
            "clone",
            "--filter=blob:none",
            "--sparse",
            "--depth=1",
            "--no-tags",
            "--branch",
            ref,
            repo_url,
            str(dest),
        ],
        cwd=dest.parent,
        ceiling=ceiling,
    )
    _git(
        ["sparse-checkout", "set", "--skip-checks", TRUSTED_SKILLS_SUBPATH],
        cwd=dest,
        ceiling=ceiling,
    )
    return dest


def _finished(dest: Path, ceiling: Path) -> bool:
    cone = _git(["sparse-checkout", "list"], cwd=dest, ceiling=ceiling, check=False)
    if cone.returncode != 0 or cone.stdout.split() != [TRUSTED_SKILLS_SUBPATH]:
        return False
    status = _git(["status", "--porcelain"], cwd=dest, ceiling=ceiling, check=False)
    return status.returncode == 0 and not status.stdout
