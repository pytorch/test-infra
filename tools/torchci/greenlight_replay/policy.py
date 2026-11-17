"""The greenlight policy under test: materialized from a pull request, then read.

A replay is only a replay if the reviewer runs under the policy of the pull request
being evaluated rather than under whatever happens to be checked out on the operator's
disk. This module fetches that pull request's tree, reads the workflow inside it via
:mod:`.workflow` and :mod:`.workflow_steps`, resolves the reviewed repo's target with
the tree's own ``greenlight target`` (:mod:`.arm_code`), holds every canned verdict to
the tree's own record checks, and presents the result as one :class:`Policy`.

**The tree comes from ``refs/pull/<N>/head``, never ``refs/pull/<N>/merge``.** GitHub
deletes the merge ref when a pull request closes -- verified on 2026-09-18 against
merged pytorch/test-infra#8828, whose head ref still fetches -- and, for as long as it
does exist, recomputes it against whatever the default branch is at that moment. A
replay pinned to a ref that is deleted or silently rebased underneath it reproduces
nothing.

**The destination is emptied before it is unpacked into, so materializing is
repeatable.** Every slot's ``.claude`` is copied from the tree and the hooks run
from it, so whatever it holds is part of the policy under test. Extraction overlays
rather than replaces, so without the clearing step a file the new policy deleted
would survive from an older run and be read as part of the policy under test.
Clearing rather than refusing is
also what lets ``--resume``, and any second run against the same policy, work.

Why the workflow is read by shape rather than by position, and why every value it
carries is required rather than defaulted, is recorded in :mod:`.workflow`.
"""

from __future__ import annotations

import logging
import os
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from torchci.greenlight_decisions.loc import _REPO_PATTERN
from torchci.greenlight_replay.arm_code import (
    canned_verdict,
    no_policy_verdict,
    resolve_target,
    Target,
)
from torchci.greenlight_replay.checkout import SCRUBBED_GIT_VARS
from torchci.greenlight_replay.ledger import require_registered
from torchci.greenlight_replay.settings import derive_hook_settings
from torchci.greenlight_replay.stack_step import StackContext
from torchci.greenlight_replay.workflow import (
    claude_args,
    diff_caps,
    load,
    prompt,
    review_budgets,
    stack_context,
    WORKFLOW_RELPATH,
)
from torchci.greenlight_replay.workflow_steps import (
    action_output_style,
    action_timeout_minutes,
    DETECTOR_RELPATH,
    detector_untrusted_dirname,
    hook_settings_text,
    no_policy_program,
    record_step,
)


__all__ = [
    "DEFAULT_POLICY_REPO",
    "GIT_REF_PATTERN",
    "HOOKS_RELPATH",
    "Policy",
    "StackContext",
    "Target",
    "WORKFLOW_RELPATH",
    "materialize",
    "refspec",
]

logger = logging.getLogger(__name__)

DEFAULT_POLICY_REPO = "pytorch/test-infra"

HOOKS_RELPATH = ".claude/hooks/greenlight"
SANITIZE_FILENAME = "sanitize-untrusted-checkout.sh"
TOO_LARGE_FILENAME = "too-large-verdict.json"

# A git ref name, safe to pass as an argv element and to splice into a REST path.
# The leading class rejects a value starting with "-", which git would read as an
# option, and the lookahead rejects "..", which git forbids in a ref name anyway and
# which would otherwise let a base ref forge a second "..." inside a compare path.
GIT_REF_PATTERN = re.compile(r"(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*")

_GIT_TIMEOUT_SECONDS = 600


@dataclass(frozen=True)
class Policy:
    """What one materialized test-infra tree says the reviewer must run under.

    ``root`` is the tree; each slot's ``.claude`` is copied from it, and the hook
    commands run its scripts by absolute path, outside the reviewer's workspace.

    ``model`` and ``effort`` are verbatim workflow values -- ``model`` is a Bedrock
    inference profile, which the caller has to map to whatever backend it invokes.

    ``review_budget_minutes`` is ``(target, soft, hard)``. They are minutes because
    that is how the workflow states them; ``budget-reminder.sh`` reads absolute epochs,
    which the caller derives from these against its own start time. ``timeout_s`` is
    the action step's ``timeout-minutes``, each review's wall clock.

    ``max_diff_files`` is None when the size gate has no file cap.

    ``hook_settings`` is the workflow's hook settings for ``target``'s checkout, as
    :func:`.settings.derive_hook_settings` validated them; ``output_style`` is the
    action step's, None without one.

    ``target`` is what the tree's ``greenlight target`` names for the reviewed repo.
    ``record_step`` is the record job's verdict validation, ``detector_script`` and
    ``detector_dirname`` the detector and the workspace directory it holds no
    instruction file may load from.

    ``too_large_verdict`` and ``no_policy_verdict`` are the canned verdicts as the record
    path processes them; ``no_policy_verdict`` is None unless ``target`` has no policy.

    ``stack_context`` says which stack context each replay gets: the one the workflow's
    stack step collects, by the :mod:`.stack_step` pin it digests to, and none without
    the step.
    """

    root: Path
    prompt_template: str
    max_diff_lines: int
    max_diff_bytes: int
    max_diff_files: int | None
    review_budget_minutes: tuple[int, int, int]
    timeout_s: int
    too_large_verdict: dict[str, str]
    no_policy_verdict: dict[str, str] | None
    sanitize_script: Path
    hooks_dir: Path
    hook_settings: dict[str, Any]
    output_style: str | None
    model: str
    effort: str
    tools: str
    target: Target
    record_step: str
    detector_script: Path
    detector_dirname: str
    stack_context: StackContext = StackContext.NONE


def materialize(
    ref: str,
    workdir: Path,
    *,
    reviewed_repo: str,
    repo: str = DEFAULT_POLICY_REPO,
) -> Policy:
    """Check ``repo`` out at ``ref`` into ``workdir`` and read the policy in it.

    ``ref`` is either a bare pull request number, which resolves to that PR's head
    ref, or any ref name or commit SHA the remote will serve. ``reviewed_repo`` is
    the repo whose pull requests are replayed, resolved by the tree's own target step.

    ``workdir`` becomes the tree root. Whatever it already held is removed first,
    so calling this twice with the same arguments is safe and yields the same
    policy -- which is what ``--resume`` and a repeated sweep both depend on.

    Raises rather than degrading on every missing piece. A policy that cannot be read
    in full is not a policy this harness can claim to have replayed.
    """
    root = Path(workdir)
    _checkout(repo, refspec(ref), root)

    workflow_path = root / WORKFLOW_RELPATH
    document = load(workflow_path)
    require_registered(document, root, workflow_path)
    model, effort, tools = claude_args(document, workflow_path)
    max_lines, max_bytes, max_files = diff_caps(document, workflow_path)
    hooks_dir = root / HOOKS_RELPATH
    # Once per sweep, before anything is spent: every one of these is a property of
    # the policy, identical for every pull request in the corpus.
    target = resolve_target(root, reviewed_repo)
    hook_settings = derive_hook_settings(
        hook_settings_text(document, workflow_path),
        root,
        target.checkout,
        workflow_path,
    )
    recorded = record_step(document, workflow_path)
    context = stack_context(document, workflow_path)
    logger.info("stack context is %s for %s", context.value, ref)

    return Policy(
        root=root,
        prompt_template=prompt(document, workflow_path),
        max_diff_lines=max_lines,
        max_diff_bytes=max_bytes,
        max_diff_files=max_files,
        review_budget_minutes=review_budgets(document, workflow_path),
        timeout_s=action_timeout_minutes(document, workflow_path) * 60,
        too_large_verdict=canned_verdict(
            root, recorded, _require_file(hooks_dir / TOO_LARGE_FILENAME), target
        ),
        no_policy_verdict=None
        if target.policy_present
        else no_policy_verdict(
            root, recorded, no_policy_program(document, workflow_path), target
        ),
        sanitize_script=_require_file(hooks_dir / SANITIZE_FILENAME),
        hooks_dir=hooks_dir,
        hook_settings=hook_settings,
        output_style=action_output_style(document, workflow_path),
        model=model,
        effort=effort,
        tools=tools,
        target=target,
        record_step=recorded,
        detector_script=_require_file(root / DETECTOR_RELPATH),
        detector_dirname=detector_untrusted_dirname(
            document, workflow_path, target.checkout
        ),
        stack_context=context,
    )


def refspec(ref: str) -> str:
    """The refspec to fetch for a bare pull request number, a ref name or a SHA.

    Public because the preflight check must ask the remote about the *same* refspec the
    real run will fetch. Resolving it separately there would let a dry run bless a ref
    the run never asks for, which is the exact failure the check exists to catch, so
    this is the single source for both.

    A bare number resolves to that PR's ``head`` -- never its ``merge``; the reason is
    in the module docstring. Anything else must be a ref name or SHA that
    ``GIT_REF_PATTERN`` accepts, so a value that would read as a git option or forge a
    second endpoint raises rather than reaching a command line.
    """
    if ref.isascii() and ref.isdigit():
        return f"refs/pull/{ref}/head"
    if not GIT_REF_PATTERN.fullmatch(ref):
        raise ValueError(f"refusing to fetch refspec {ref!r}")
    return ref


def _checkout(repo: str, refspec: str, dest: Path) -> None:
    if not _REPO_PATTERN.fullmatch(repo):
        raise ValueError(f"refusing to build a clone URL from repo {repo!r}")
    _clear_destination(dest)
    # No exist_ok: _clear_destination has just guaranteed the path is gone, so a
    # directory here means something else is writing to it concurrently.
    dest.mkdir(parents=True)

    url = f"https://github.com/{repo}.git"
    # Beside the tree rather than in $TMPDIR, so the whole run stays under
    # --workdir as the README promises. Never inside dest: the tree must hold
    # the ref's contents and nothing else.
    with tempfile.TemporaryDirectory(
        prefix="greenlight-policy-", dir=dest.parent
    ) as scratch_name:
        scratch = Path(scratch_name)
        # A scratch bare repository rather than the checkout the harness runs from:
        # the policy tree must neither depend on nor add objects to the operator's
        # own repository, and a worktree's .git file points back into its admin dir,
        # so copying one would aim a later `git clean` at the real working tree.
        mirror = Path(scratch) / "mirror.git"
        _git(["init", "--bare", "--quiet", str(mirror)], cwd=scratch, ceiling=scratch)
        _git(
            ["fetch", "--depth", "1", "--no-tags", "--quiet", url, refspec],
            cwd=mirror,
            ceiling=scratch,
        )
        archive = Path(scratch) / "policy.tar"
        _git(
            ["archive", "--format=tar", f"--output={archive}", "FETCH_HEAD"],
            cwd=mirror,
            ceiling=scratch,
        )
        with tarfile.open(archive) as tar:
            # `data` refuses absolute paths, parent traversal, links pointing out of
            # the tree and setuid bits. The archive is built from a pull request, so
            # it is exactly as trustworthy as whoever opened it.
            tar.extractall(dest, filter="data")
    logger.info("materialized %s %s into %s", repo, refspec, dest)


def _confined_env(ceiling: Path) -> dict[str, str]:
    """The ambient environment with every repository-naming variable removed.

    Only the variable list is shared with ``checkout.py``, not its ``_git_env`` helper:
    that one also sets ``GIT_NO_LAZY_FETCH``, which exists for its blobless clone and
    means nothing to this plain shallow mirror. Importing the data rather than the
    function keeps the one rule that matters -- which names redirect git -- in a single
    place without coupling this module to a signature it does not need.
    """
    env = {k: v for k, v in os.environ.items() if k not in SCRUBBED_GIT_VARS}
    env["GIT_CEILING_DIRECTORIES"] = str(ceiling)
    return env


def _clear_destination(dest: Path) -> None:
    """Remove a previously materialized tree so the extraction starts from nothing.

    One of three guarded deletions in this package; the others are
    ``workspace._clear_policy_half``, which clears a slot's copied ``.claude`` under
    equivalent guards, and ``stack.clear_stack``, which clears a run directory's stack
    context and refuses a symlink the same way. Anyone auditing what this harness can
    delete wants all three.

    A path bug in any would be the most destructive thing here, so this one refuses
    anything that is not recognisably a tree this module created: a symlink (which
    could aim the removal somewhere else entirely), a non-directory, a filesystem root,
    the home directory, and above all a directory holding a ``.git`` -- a materialized
    tree never has one, because ``git archive`` emits no history, so a ``.git`` means
    the destination is somebody's real checkout.
    """
    if dest.is_symlink():
        raise ValueError(f"refusing to remove {dest}: it is a symlink")
    if not dest.exists():
        return
    if not dest.is_dir():
        raise ValueError(f"refusing to remove {dest}: it is not a directory")
    resolved = dest.resolve()
    if resolved.parent == resolved:
        raise ValueError(f"refusing to remove {dest}: it is a filesystem root")
    if resolved == Path(os.path.expanduser("~")).resolve():
        raise ValueError(f"refusing to remove {dest}: it is the home directory")
    if (resolved / ".git").exists():
        raise ValueError(
            f"refusing to remove {dest}: it holds a .git, so it is a real checkout "
            "rather than a policy tree this harness materialized"
        )
    shutil.rmtree(dest)


def _git(argv: list[str], *, cwd: Path, ceiling: Path) -> None:
    """Run one git command confined to ``ceiling``, in an explicit directory.

    ``cwd`` and ``ceiling`` are required rather than defaulted because neither has a
    safe default. Inheriting the operator's working directory would run ``git init``
    wherever the sweep was launched from, and the environment alone can redirect a
    command that names its repository perfectly well: ``GIT_DIR`` short-circuits
    discovery, so a fetch aimed at this mirror writes ``FETCH_HEAD`` and its objects
    into whatever ``GIT_DIR`` names -- on this machine, potentially the operator's own
    test-infra checkout -- after which ``git archive FETCH_HEAD`` would build the
    policy tree out of that repository rather than the mirror.

    The list of variables to scrub is ``checkout.py``'s, imported rather than
    restated -- which names redirect git is one rule for this package.
    """
    completed = subprocess.run(
        ["git", *argv],
        capture_output=True,
        check=False,
        cwd=str(cwd),
        env=_confined_env(ceiling),
        timeout=_GIT_TIMEOUT_SECONDS,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"{shlex.join(['git', *argv])} exited {completed.returncode}: "
            f"{stderr[:400]}"
        )


def _require_file(path: Path) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"policy tree has no {path}")
    return path
