"""The greenlight policy under test: materialized from a pull request, then read.

A replay is only a replay if the reviewer runs under the policy of the pull request
being evaluated rather than under whatever happens to be checked out on the operator's
disk. This module fetches that pull request's tree, reads the workflow inside it via
:mod:`.workflow`, and presents the result as one :class:`Policy`.

**The tree comes from ``refs/pull/<N>/head``, never ``refs/pull/<N>/merge``.** GitHub
deletes the merge ref when a pull request closes -- verified on 2026-09-18 against
merged pytorch/test-infra#8828, whose head ref still fetches -- and, for as long as it
does exist, recomputes it against whatever the default branch is at that moment. A
replay pinned to a ref that is deleted or silently rebased underneath it reproduces
nothing.

**The destination is emptied before it is unpacked into, so materializing is
repeatable.** The tree doubles as the reviewer's workspace root, so anything nested
under it is reachable by the model -- a run directory kept there would expose other
pull requests' diffs and verdicts. Extraction overlays rather than replaces, so
without the clearing step a file the new policy deleted would survive from an older
run and be read as part of the policy under test. Clearing rather than refusing is
also what lets ``--resume``, and any second run against the same policy, work.

Why the workflow is read by shape rather than by position, and why every value it
carries is required rather than defaulted, is recorded in :mod:`.workflow`.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from torchci.greenlight_decisions.loc import _REPO_PATTERN
from torchci.greenlight_replay.checkout import SCRUBBED_GIT_VARS
from torchci.greenlight_replay.transcript import _schema_violation
from torchci.greenlight_replay.workflow import (
    claude_args,
    diff_caps,
    load,
    prompt,
    review_budgets,
    WORKFLOW_RELPATH,
)


__all__ = [
    "DEFAULT_POLICY_REPO",
    "GIT_REF_PATTERN",
    "HOOKS_RELPATH",
    "Policy",
    "WORKFLOW_RELPATH",
    "materialize",
    "render_prompt",
]

logger = logging.getLogger(__name__)

DEFAULT_POLICY_REPO = "pytorch/test-infra"

HOOKS_RELPATH = ".claude/hooks/greenlight"
SCHEMA_FILENAME = "verdict-schema.json"
SANITIZE_FILENAME = "sanitize-untrusted-checkout.sh"
TOO_LARGE_FILENAME = "too-large-verdict.json"

PR_NUMBER_EXPR = "github.event.inputs.pr_number"
HEAD_SHA_EXPR = "github.event.inputs.head_sha"

# A git ref name, safe to pass as an argv element and to splice into a REST path.
# The leading class rejects a value starting with "-", which git would read as an
# option, and the lookahead rejects "..", which git forbids in a ref name anyway and
# which would otherwise let a base ref forge a second "..." inside a compare path.
GIT_REF_PATTERN = re.compile(r"(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*")

_INTERPOLATION = re.compile(r"\$\{\{(.*?)\}\}", re.DOTALL)
_INTERPOLATION_OPEN = re.compile(r"\$\{\{")

_GIT_TIMEOUT_SECONDS = 600


@dataclass(frozen=True)
class Policy:
    """What one materialized test-infra tree says the reviewer must run under.

    ``root`` doubles as the reviewer's workspace root, so the hook scripts under
    ``hooks_dir`` resolve against it exactly as they do against ``GITHUB_WORKSPACE``
    in CI.

    ``model`` and ``effort`` are verbatim workflow values -- ``model`` is a Bedrock
    inference profile, which the caller has to map to whatever backend it invokes.

    ``review_budget_minutes`` is ``(target, soft, hard)``. They are minutes because
    that is how the workflow states them; ``budget-reminder.sh`` reads absolute epochs,
    which the caller derives from these against its own start time.
    """

    root: Path
    prompt_template: str
    max_diff_lines: int
    max_diff_bytes: int
    review_budget_minutes: tuple[int, int, int]
    too_large_verdict: dict[str, str]
    schema_path: Path
    sanitize_script: Path
    hooks_dir: Path
    model: str
    effort: str
    tools: str


def materialize(ref: str, workdir: Path, *, repo: str = DEFAULT_POLICY_REPO) -> Policy:
    """Check ``repo`` out at ``ref`` into ``workdir`` and read the policy in it.

    ``ref`` is either a bare pull request number, which resolves to that PR's head
    ref, or any ref name or commit SHA the remote will serve.

    ``workdir`` becomes the tree root. Whatever it already held is removed first,
    so calling this twice with the same arguments is safe and yields the same
    policy -- which is what ``--resume`` and a repeated sweep both depend on.

    Raises rather than degrading on every missing piece. A policy that cannot be read
    in full is not a policy this harness can claim to have replayed.
    """
    root = Path(workdir)
    _checkout(repo, _refspec(ref), root)

    workflow_path = root / WORKFLOW_RELPATH
    document = load(workflow_path)
    model, effort, tools = claude_args(document, workflow_path)
    max_lines, max_bytes = diff_caps(document, workflow_path)
    hooks_dir = root / HOOKS_RELPATH
    schema_path = _require_file(hooks_dir / SCHEMA_FILENAME)
    schema = json.loads(schema_path.read_text(encoding="utf-8"))

    return Policy(
        root=root,
        prompt_template=prompt(document, workflow_path),
        max_diff_lines=max_lines,
        max_diff_bytes=max_bytes,
        review_budget_minutes=review_budgets(document, workflow_path),
        too_large_verdict=_too_large_verdict(hooks_dir / TOO_LARGE_FILENAME, schema),
        schema_path=schema_path,
        sanitize_script=_require_file(hooks_dir / SANITIZE_FILENAME),
        hooks_dir=hooks_dir,
        model=model,
        effort=effort,
        tools=tools,
    )


def render_prompt(policy: Policy, pr_number: int, head_sha: str) -> str:
    """Resolve the two dispatch-input interpolations the prompt template carries.

    Any other ``${{ ... }}`` aborts. An unresolved interpolation is not a crash, it is
    a successful-looking run: the reviewer is told it is reviewing PR
    ``${{ github.event.inputs.pr_number }}`` and returns a verdict about nothing.
    """
    _reject_unclosed(policy.prompt_template)
    substitutions = {
        PR_NUMBER_EXPR: str(pr_number),
        HEAD_SHA_EXPR: head_sha,
    }
    unresolved: list[str] = []

    def replace(match: re.Match[str]) -> str:
        expression = match.group(1).strip()
        if expression in substitutions:
            return substitutions[expression]
        unresolved.append(expression)
        return match.group(0)

    # One pass: a substituted value that itself contains "${{" is never rescanned.
    rendered = _INTERPOLATION.sub(replace, policy.prompt_template)
    if unresolved:
        raise ValueError(
            "prompt template carries interpolations this harness cannot resolve: "
            + ", ".join(sorted(set(unresolved)))
        )
    return rendered


def _reject_unclosed(template: str) -> None:
    """Every ``${{`` in the template must open a well-formed interpolation.

    The substitution pattern only sees balanced ``${{ ... }}``, so a template carrying
    ``${{ github.event.inputs.pr_number }`` -- one closing brace -- renders verbatim and
    trips nothing, which defeats the whole guard. Checked against the template rather
    than the rendered text so that a substituted value which happens to contain ``${{``
    is not mistaken for the policy's own malformed markup.
    """
    for match in _INTERPOLATION_OPEN.finditer(template):
        if _INTERPOLATION.match(template, match.start()) is None:
            excerpt = template[match.start() : match.start() + 60]
            raise ValueError(
                "prompt template carries an interpolation that never closes: "
                f"{excerpt!r}"
            )


def _refspec(ref: str) -> str:
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

    One of two guarded deletions in this package; the other is
    ``workspace._clear_policy_half``, which clears a slot's copied ``.claude`` under
    equivalent guards. Anyone auditing what this harness can delete wants both.

    A path bug in either would be the most destructive thing here, so this one refuses
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


def _too_large_verdict(path: Path, schema: Mapping[str, Any]) -> dict[str, str]:
    """The canned decline, read from the tree and held to the tree's own schema.

    Validated rather than merely shape-checked because this verdict is emitted with no
    model ever running, so nothing downstream re-checks it. A policy PR that mistyped
    ``status`` would have every oversized pull request land a blank ``new_decision`` --
    the emit layer drops a status outside LAND/NO_LAND -- and nothing would say why.

    The schema comes from the materialized tree, so a policy PR that widens the reason
    enum widens what its own canned verdict may say.
    """
    _require_file(path)
    verdict = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(verdict, dict):
        raise ValueError(f"{path} did not parse as an object")
    violation = _schema_violation(schema, verdict)
    if violation:
        raise ValueError(f"{path}: {violation}")
    return dict(verdict)


def _require_file(path: Path) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"policy tree has no {path}")
    return path
