"""Check out the trusted tree of the reviewed repo: the sanitize step's skills, the repo's policy.

``materialize_trusted_skills`` makes the second argument of
``sanitize-untrusted-checkout.sh`` and the trusted checkout ``repo-policy.py stage``
reads: a sparse checkout of the reviewed repo whose cone is ``.claude/skills`` and
``.github/greenlight``, at one pinned commit or at ``main``. It stays a git checkout,
because the staging script reads the repo's policy from git objects rather than from
the filesystem. Its git calls go through ``checkout``'s confined helpers.
"""

from __future__ import annotations

from pathlib import Path

from torchci.greenlight_replay.checkout import (
    _git,
    _require_sha,
    _require_url,
    clone_url,
    DEFAULT_REPO,
    GitError,
)


__all__ = ["TRUSTED_CONE", "materialize_trusted_skills"]

TRUSTED_SKILLS_SUBPATH = ".claude/skills"
# As CI's trusted checkout of the reviewed repo: the skills the sanitize step restores
# and the directory holding the repo's own GreenLight config and review policy.
TRUSTED_CONE = (TRUSTED_SKILLS_SUBPATH, ".github/greenlight")
DEFAULT_BRANCH = "main"


def materialize_trusted_skills(
    dest: Path,
    *,
    repo_url: str = clone_url(DEFAULT_REPO),
    sha: str | None = None,
) -> Path:
    """Check out ``repo_url``'s trusted cone once, at ``sha`` or else at ``main``.

    ``sanitize-untrusted-checkout.sh`` takes TWO required arguments -- the untrusted
    checkout and a directory to restore trusted skills FROM -- and exits 1 when given one.
    CI supplies the second from a separate sparse checkout of the reviewed repo's main, and
    this is the local equivalent. The second argument must never point at the policy tree: that would
    copy greenlight's own reviewer skill into the tree being reviewed.

    ``sha`` pins every arm of a comparison to the same trusted tree; ``main`` moves under
    a sweep and between arms. A checkout already at ``dest`` is reused only when it is a
    finished one at ``sha``: a tree at any other commit raises rather than being reused,
    so callers key ``dest`` by the SHA. Without ``sha`` a tree whose ``.claude/skills``
    exists is reused as it is.

    ``.claude/skills`` can be a symlink whose target lies outside the cone. CI's checkout
    sets the cone before anything is checked out, so git never vets that path and the link
    arrives dangling, which the sanitize step reads as no skills to restore. Here the cone
    is set before the checkout too, and ``--skip-checks`` lets cone mode name a path
    the index may hold as a file. CI's checkout succeeds whatever the repo holds at
    those paths -- a directory, a link, a file or nothing -- and so does this one; a later
    call recognizes it by its cone, which a half-finished clone never got, and by a tree
    still matching its commit.

    Returns ``dest``, the directory to pass as the sanitize script's second argument.
    """
    _require_url(repo_url)
    if sha is not None:
        _require_sha(sha)
    dest = dest.resolve()
    skills = dest / TRUSTED_SKILLS_SUBPATH
    if sha is None and (skills.is_dir() or skills.is_symlink()):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The PARENT of the directory git is asked to work in. A ceiling equal to the process
    # working directory is ignored outright, so `ceiling=dest.parent` while cloning FROM
    # dest.parent confines nothing.
    ceiling = dest.parent.parent
    if (dest / ".git").exists():
        if _finished(dest, ceiling, sha):
            return dest
        # Loud rather than silent, and deliberately the same stance policy._clear_destination
        # takes: any other .git here is a half-finished clone whose cone was never set --
        # which a silent skip would make permanent, since the guard would keep seeing .git
        # and never re-clone -- a checkout changed since or at another commit, or somebody's
        # real checkout, which must not be written into either way.
        raise GitError(
            f"{dest} already holds a .git but is no finished trusted checkout at "
            f"{sha or DEFAULT_BRANCH}; it is a half-finished clone, a changed checkout, "
            "one at another commit or a real one. Remove it and re-run."
        )
    _git(
        [
            "clone",
            "--filter=blob:none",
            "--sparse",
            "--no-checkout",
            "--depth=1",
            "--no-tags",
            # With a SHA the clone's own branch is never checked out, so it takes the
            # remote's default whatever it is named.
            *(["--branch", DEFAULT_BRANCH] if sha is None else []),
            repo_url,
            str(dest),
        ],
        cwd=dest.parent,
        ceiling=ceiling,
    )
    _git(
        ["sparse-checkout", "set", "--skip-checks", *TRUSTED_CONE],
        cwd=dest,
        ceiling=ceiling,
    )
    if sha is None:
        _git(["checkout", "--quiet", DEFAULT_BRANCH], cwd=dest, ceiling=ceiling)
        return dest
    _git(
        ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", "--", sha],
        cwd=dest,
        ceiling=ceiling,
    )
    _git(["checkout", "--quiet", "--detach", sha], cwd=dest, ceiling=ceiling)
    if not _at(dest, ceiling, sha):
        raise GitError(f"{dest} did not check out {sha}")
    return dest


def _finished(dest: Path, ceiling: Path, sha: str | None) -> bool:
    cone = _git(["sparse-checkout", "list"], cwd=dest, ceiling=ceiling, check=False)
    if cone.returncode != 0 or sorted(cone.stdout.split()) != sorted(TRUSTED_CONE):
        return False
    if sha is not None and not _at(dest, ceiling, sha):
        return False
    status = _git(["status", "--porcelain"], cwd=dest, ceiling=ceiling, check=False)
    return status.returncode == 0 and not status.stdout


def _at(dest: Path, ceiling: Path, sha: str) -> bool:
    head = _git(["rev-parse", "HEAD"], cwd=dest, ceiling=ceiling, check=False)
    return head.returncode == 0 and head.stdout.strip() == sha
