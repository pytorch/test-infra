"""Worktree pool that materializes reviewed pytorch/pytorch commits for replay.

A replay evaluates hundreds of historical PRs, each pinned to a different head SHA, and
runs several reviewers at once. The naive shape -- one shallow clone per PR -- pays the
whole clone cost per PR and keeps nothing between them. This module instead keeps ONE
shared bare blobless clone (``git clone --filter=blob:none --bare``, measured 2026-09-18
at 16 s and 256 MB against pytorch/pytorch) and hands out ``git worktree`` slots from it,
so every SHA already in the corpus is a local checkout rather than a network round trip.
Roughly 82% of the corpus head SHAs are reachable from that clone's refs; the remainder
are fetched on demand.

Two fetch shapes are needed because two kinds of SHA go missing. A commit that is simply
newer or on an unreferenced branch arrives via ``git fetch origin <sha>`` (~1.2 s). A
commit that lives only on a fork's branch is not fetchable by SHA at all -- GitHub serves
it only through the pull request ref -- so the fallback fetches ``refs/pull/<N>/head``.
Together they reached 363/363 of the sampled corpus.

Blobs are the cost that moves. A blobless clone carries commits and trees but downloads
file contents on demand, so the FIRST checkout into a fresh slot drags most of a pytorch
working tree over the network and is far slower than the ones that follow; subsequent
checkouts in the same pool reuse those blobs from the shared object store. Sizing the pool
to the parallelism and reusing slots is therefore what makes the replay affordable, not an
optimization to be tuned away later.

Reusing a slot is also the subtle hazard. ``sanitize-untrusted-checkout.sh`` deletes
tracked paths (every CLAUDE.md, AGENTS.md and .claude tree) and copies an untracked skills
tree back in, so a slot that has hosted one review is left dirty. Checking the next SHA
into it without resetting first either fails outright or, worse, silently carries the
previous PR's deletions forward -- the next PR then gets reviewed against a tree CI would
never have produced. Every acquisition therefore resets the slot before use.

Each slot is laid out as a reviewer workspace rather than as a bare checkout: the worktree
is ``<slot>/pytorch`` and ``<slot>`` is what the reviewer is given as ``GITHUB_WORKSPACE``.
That is not cosmetic. ``restrict-read.py`` computes its allowed roots as
``<workspace>/pytorch`` and ``<workspace>/.claude/{skills,hooks}``, and ``--restricted``
confines the file tools to the ``--add-dir`` roots after resolving symlinks -- so a shared
workspace pointing at a per-run checkout through a symlink would be denied, and a single
shared ``pytorch`` directory cannot serve concurrent reviews at all. Giving every slot its
own workspace parent satisfies both with no indirection. The caller populates
``<slot>/.claude`` from the policy tree.

Git resolves a repository by walking UP from the working directory, so a subprocess
launched in a scratch slot acts on whatever repository encloses it -- on a machine where
``~`` is itself a repository that is a real hazard. Every git call here runs with the
repository-naming environment variables scrubbed and with ``GIT_CEILING_DIRECTORIES`` set
to the worktree's PARENT, because git stops strictly below a ceiling entry and ignores a
ceiling equal to the process working directory.
"""

from __future__ import annotations

import contextlib
import os
import re
import subprocess
import threading
from collections.abc import Iterator, Sequence
from pathlib import Path


__all__ = [
    "GitError",
    "PYTORCH_REPO_URL",
    "SCRUBBED_GIT_VARS",
    "WorktreePool",
    "git_env",
    "materialize_trusted_skills",
]

PYTORCH_REPO_URL = "https://github.com/pytorch/pytorch.git"

TRUSTED_SKILLS_SUBPATH = ".claude/skills"

# restrict-read.py hardcodes <workspace>/pytorch as the checkout it will serve reads from.
PYTORCH_CHECKOUT_DIRNAME = "pytorch"

_SHA_RE = re.compile(r"\A[0-9a-f]{40}\Z")

# Each of these names a repository outright and short-circuits the upward walk before any
# ceiling is consulted, so a ceiling alone does not confine a subprocess. Shared with
# policy.py, which applies the same list in its own confined environment rather than calling
# git_env: a plain shallow mirror has no promisor remote, so the lazy-fetch control below
# means nothing to it.
SCRUBBED_GIT_VARS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
)


class GitError(RuntimeError):
    """A git subprocess failed, or its result contradicts what was asked for."""


def _require_sha(head_sha: str) -> str:
    """Reject anything that is not a full lowercase hex SHA.

    The SHA arrives from a CSV column and is interpolated into a git command line, where a
    leading dash would be read as an option (``--upload-pack=`` executes a command).
    """
    if not _SHA_RE.match(head_sha or ""):
        raise GitError(f"not a full 40-character lowercase hex SHA: {head_sha!r}")
    return head_sha


def _require_url(repo_url: str) -> str:
    if not repo_url or repo_url.startswith("-"):
        raise GitError(
            f"refusing a repository URL that parses as an option: {repo_url!r}"
        )
    return repo_url


def git_env(ceiling: Path, *, lazy_fetch: bool) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in SCRUBBED_GIT_VARS}
    env["GIT_CEILING_DIRECTORIES"] = str(ceiling)
    if not lazy_fetch:
        env["GIT_NO_LAZY_FETCH"] = "1"
    return env


def _git(
    args: Sequence[str],
    *,
    cwd: Path,
    ceiling: Path,
    check: bool = True,
    timeout_s: int = 1800,
    lazy_fetch: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run one git command, confined to ``ceiling`` and below.

    ``lazy_fetch=False`` sets ``GIT_NO_LAZY_FETCH`` and belongs to exactly one caller, the
    presence probe, where a miss must stay a miss rather than become a slow promisor fetch.
    It is NOT safe as a default: this pool's whole point is a blobless clone, which holds no
    file contents at all, so ``clone``, ``worktree add`` and ``checkout`` all depend on the
    promisor fetch it disables and die with "could not fetch <oid> from promisor remote".
    """
    completed = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=git_env(ceiling, lazy_fetch=lazy_fetch),
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    if check and completed.returncode != 0:
        raise GitError(
            f"git {' '.join(args)} failed in {cwd} (exit {completed.returncode}): "
            f"{completed.stderr.strip()}"
        )
    return completed


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

    Returns ``dest``, the directory to pass as the sanitize script's second argument.
    """
    _require_url(repo_url)
    dest = dest.resolve()
    if (dest / TRUSTED_SKILLS_SUBPATH).is_dir():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The PARENT of the directory git is asked to work in. A ceiling equal to the process
    # working directory is ignored outright, so `ceiling=dest.parent` while cloning FROM
    # dest.parent confines nothing.
    ceiling = dest.parent.parent
    if (dest / ".git").exists():
        # Loud rather than silent, and deliberately the same stance policy._clear_destination
        # takes: a .git here is either a half-finished clone whose skills tree never
        # materialized -- which a silent skip would make permanent, since the guard would
        # keep seeing .git and never re-clone -- or somebody's real checkout, which must
        # not be written into either way.
        raise GitError(
            f"{dest} already holds a .git but no {TRUSTED_SKILLS_SUBPATH}; it is either a "
            "half-finished clone or a real checkout. Remove it and re-run."
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
    _git(["sparse-checkout", "set", TRUSTED_SKILLS_SUBPATH], cwd=dest, ceiling=ceiling)
    if not (dest / TRUSTED_SKILLS_SUBPATH).is_dir():
        raise GitError(
            f"{ref} of {repo_url} produced no {TRUSTED_SKILLS_SUBPATH} in {dest}"
        )
    return dest


class WorktreePool:
    """A fixed set of reviewer workspaces, each holding a worktree of one shared clone.

    Safe to use from a thread pool: ``acquire`` blocks until a slot is free, and the
    operations that mutate the shared object store or the shared worktree registry are
    serialized, while the per-slot checkout -- the slow part -- runs concurrently.
    """

    def __init__(
        self,
        bare_clone: Path,
        slots: int,
        repo_url: str = PYTORCH_REPO_URL,
    ) -> None:
        if slots < 1:
            raise ValueError(f"slots must be at least 1, got {slots}")
        self.bare_clone = Path(bare_clone).resolve()
        self.repo_url = _require_url(repo_url)
        self.slots = slots
        self.slot_root = self.bare_clone.parent / f"{self.bare_clone.name}-slots"
        self._free = [
            self.slot_root / f"slot-{index}" / PYTORCH_CHECKOUT_DIRNAME
            for index in range(slots)
        ]
        self._in_use: set[Path] = set()
        self._pool_lock = threading.Lock()
        self._repo_lock = threading.Lock()
        self._available = threading.Semaphore(slots)

    @staticmethod
    def workspace_of(worktree: Path) -> Path:
        """The ``GITHUB_WORKSPACE`` root that holds ``worktree`` as its ``pytorch`` dir."""
        return Path(worktree).parent

    def ensure_clone(self) -> None:
        """Create the shared bare blobless clone if it is not already there."""
        with self._repo_lock:
            if (self.bare_clone / "HEAD").is_file():
                return
            self.bare_clone.parent.mkdir(parents=True, exist_ok=True)
            self.slot_root.mkdir(parents=True, exist_ok=True)
            _git(
                [
                    "clone",
                    "--filter=blob:none",
                    "--bare",
                    "--no-tags",
                    self.repo_url,
                    str(self.bare_clone),
                ],
                cwd=self.bare_clone.parent,
                # The PARENT of the working directory: a ceiling equal to cwd is ignored.
                ceiling=self.bare_clone.parent.parent,
            )

    def acquire(self, head_sha: str, *, pr_number: int | None = None) -> Path:
        """Block for a free slot, reset it, check ``head_sha`` out, and return the worktree.

        The reviewer's workspace is the returned path's parent; see ``workspace_of``.

        ``pr_number`` is what makes a fork commit reachable; without it a SHA that exists
        only on a fork branch cannot be fetched at all and the call raises.
        """
        _require_sha(head_sha)
        self._available.acquire()
        try:
            with self._pool_lock:
                slot = self._free.pop()
                self._in_use.add(slot)
        except BaseException:
            self._available.release()
            raise
        try:
            self._ensure_commit(head_sha, pr_number)
            self._checkout(slot, head_sha)
        except BaseException:
            self.release(slot)
            raise
        return slot

    def release(self, path: Path) -> None:
        """Return a slot to the pool. The slot is reset on its next acquisition."""
        slot = Path(path)
        with self._pool_lock:
            if slot not in self._in_use:
                raise ValueError(f"{slot} is not an acquired slot of this pool")
            self._in_use.discard(slot)
            self._free.append(slot)
        self._available.release()

    @contextlib.contextmanager
    def checkout(
        self, head_sha: str, *, pr_number: int | None = None
    ) -> Iterator[Path]:
        slot = self.acquire(head_sha, pr_number=pr_number)
        try:
            yield slot
        finally:
            self.release(slot)

    def has_commit(self, head_sha: str) -> bool:
        """Whether the commit is already local. The one place lazy fetching is disabled.

        Without that, a miss answers itself by fetching the object, so the probe reports
        every SHA as present and takes seconds to say so.
        """
        completed = _git(
            ["cat-file", "-e", f"{_require_sha(head_sha)}^{{commit}}"],
            cwd=self.bare_clone,
            ceiling=self.bare_clone.parent,
            check=False,
            timeout_s=120,
            lazy_fetch=False,
        )
        return completed.returncode == 0

    def _ensure_commit(self, head_sha: str, pr_number: int | None) -> None:
        if self.has_commit(head_sha):
            return
        with self._repo_lock:
            if self.has_commit(head_sha):
                return
            # No --depth here. The clone already carries full commit history, so a depth
            # bound saves no transfer, and it marks the SHARED clone shallow -- one grafted
            # boundary per fetched SHA, for roughly one corpus pull request in five.
            by_sha = _git(
                ["fetch", "--filter=blob:none", "--no-tags", "origin", head_sha],
                cwd=self.bare_clone,
                ceiling=self.bare_clone.parent,
                check=False,
            )
            if by_sha.returncode != 0:
                if pr_number is None:
                    raise GitError(
                        f"{head_sha} is not fetchable by SHA and no PR number was given to "
                        f"try refs/pull/<N>/head: {by_sha.stderr.strip()}"
                    )
                _git(
                    [
                        "fetch",
                        "--filter=blob:none",
                        "--no-tags",
                        "origin",
                        f"refs/pull/{int(pr_number)}/head",
                    ],
                    cwd=self.bare_clone,
                    ceiling=self.bare_clone.parent,
                )
            if not self.has_commit(head_sha):
                raise GitError(
                    f"{head_sha} is still absent after fetching from {self.repo_url}"
                )

    def _checkout(self, worktree: Path, head_sha: str) -> None:
        if (worktree / ".git").exists():
            # Resetting is not housekeeping: the previous review's sanitize pass deleted
            # tracked paths and left an untracked skills tree behind, and checking out over
            # that either fails or carries those deletions into the next PR's review.
            ceiling = worktree.parent
            _git(
                ["checkout", "-f", "--detach", head_sha], cwd=worktree, ceiling=ceiling
            )
            _git(["clean", "-xdff"], cwd=worktree, ceiling=ceiling)
            return
        worktree.parent.mkdir(parents=True, exist_ok=True)
        with self._repo_lock:
            _git(
                ["worktree", "add", "--detach", "--force", str(worktree), head_sha],
                cwd=self.bare_clone,
                ceiling=self.bare_clone.parent,
            )
