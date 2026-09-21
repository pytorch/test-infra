"""What a sweep can refuse before it clones anything or spends anything.

Every check here answers a question about the operator's invocation rather than
about the policy, so none of them needs the policy tree and all of them run in
under a second. That is what lets ``--dry-run`` make them too: a dry run is the
one chance to catch a mistyped pull request number before a real run has already
built a scratch tree and a bare clone to discover it.

The checks that need the materialized policy -- its verdict schema, its hook
scripts -- necessarily come later, and live with the sweep.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

from torchci.greenlight_replay.hooks import remap
from torchci.greenlight_replay.policy import DEFAULT_POLICY_REPO, refspec
from torchci.greenlight_replay.runner import CLAUDE_BIN, SUBPROCESS_PATH, TIMEOUT_BIN


RUNS_DIRNAME = "runs"
LS_REMOTE_TIMEOUT_S = 60

logger = logging.getLogger(__name__)


def preflight(workdir: Path, policy_ref: str, repo: str = DEFAULT_POLICY_REPO) -> None:
    """Everything that can be refused before a sweep touches the network or spends."""
    check_workdir(workdir)
    check_binaries()
    check_policy_ref(policy_ref, repo)


def check_policy_ref(ref: str, repo: str = DEFAULT_POLICY_REPO) -> None:
    """Refuse a policy ref the remote does not have.

    A mistyped pull request number is the likeliest way to start a sweep wrong,
    and materializing the policy is what would otherwise catch it -- which a dry
    run deliberately does not do, so the dry run would price a plan that cannot
    run. ``ls-remote`` asks the same question with no clone, no fetch and no
    scratch directory, against the refspec ``policy.refspec`` resolves -- the same
    one the real fetch will use, which is the whole value of asking.
    """
    wanted = refspec(ref)
    completed = subprocess.run(
        ["git", "ls-remote", "--exit-code", _clone_url(repo), wanted],
        capture_output=True,
        check=False,
        timeout=LS_REMOTE_TIMEOUT_S,
    )
    if completed.returncode != 0:
        raise ValueError(
            f"{repo} has no {wanted}. Check the policy pull request number"
        )
    logger.info("%s has %s", repo, wanted)


def check_binaries(path: str = SUBPROCESS_PATH) -> None:
    """Refuse a sweep the reviewer's own PATH could not launch.

    The reviewer's environment is replaced wholesale with a pinned PATH rather
    than inherited, so a binary on the operator's PATH is not necessarily on the
    one the subprocess is given.
    """
    missing = [
        name
        for name in (CLAUDE_BIN, TIMEOUT_BIN)
        if shutil.which(name, path=path) is None
    ]
    if missing:
        raise FileNotFoundError(
            f"{', '.join(missing)} is not on the reviewer's PATH ({path}); "
            "every run would fail to launch"
        )


def check_workdir(workdir: Path) -> None:
    """Refuse a scratch root outside the read sandbox's own allowlist.

    Defence in depth rather than load-bearing today: the PreToolUse hooks judge
    the un-remapped ``/tmp/greenlight-*`` path, which is always allowed, so reads
    succeed wherever the run directory lives. It keeps the design correct against
    a CLI that chains ``updatedInput``, where a directory outside the prefix
    would instead deny every read. ``remap.run_dir_violation`` refuses one
    outright, so checking here turns a per-pull-request failure into a startup one.
    """
    violation = remap.run_dir_violation(str((workdir / RUNS_DIRNAME).resolve()))
    if violation is not None:
        raise ValueError(f"--workdir {workdir} is unusable: {violation}")


def _clone_url(repo: str) -> str:
    return f"https://github.com/{repo}.git"
