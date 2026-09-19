"""The two files the greenlight reviewer reads, rebuilt for one historical decision.

CI hands the model a unified diff at ``/tmp/greenlight-pr.diff`` and, when it can be
fetched, a small metadata document at ``/tmp/greenlight-pr.json``. This module rebuilds
both from GitHub for a pull request the reviewer has already judged once, and applies
the policy's size gate to the diff exactly as the workflow's ``sizecheck`` step does.

**The compare is against the base REF, not the base SHA.** Roughly 60% of the corpus is
ghstack, whose pull requests are opened against a synthetic ``gh/<user>/<n>/base``
branch. Comparing against ``main`` instead returns the whole stack below the PR as well
as the PR itself -- a completely different change, reviewed under a verdict that was
never about it. The workflow reads ``baseRefName`` for the same reason, and this is the
single most load-bearing detail in the module.

Two things here deliberately differ from CI, and both are corrections a replay needs
rather than fidelity it loses:

*Comments are filtered to those created strictly before the verdict being replayed.*
CI has no time filter because CI runs once, live. A replay of a decision from months
ago would otherwise feed the model everything said since -- including pytorchmergebot's
merge confirmation on a PR that has already landed, which answers the very question the
reviewer is being asked. One leak survives the filter: greenlight edits its own status
comment in place, so a comment with an old ``createdAt`` can carry today's body. That
residual is known and accepted.

*An unreadable ``createdAt`` excludes the comment.* The filter exists to keep the future
out of the reviewer's context, so a comment that cannot prove it is old is exactly the
one that must not be let through.

Everything else reproduces CI including its defects. The bot exclusions are the
workflow's jq filter verbatim: the ``*[bot]`` glob catches only the REST-shaped
``<app>[bot]`` login, so GraphQL-shaped App logins reach the model as human comments --
``vercel`` on pytorch/test-infra#8828, confirmed 2026-09-18. This harness reproduces the
reviewer's inputs; it does not improve them.

Metadata collection is best-effort, as in CI, where the step is ``continue-on-error``
and the prompt calls the file optional. A metadata failure yields ``metadata_path=None``
and the review still runs -- degrading it into a failed replay would discard a perfectly
good diff over a field the reviewer may not even consult.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from torchci.greenlight_decisions.loc import _REPO_PATTERN, _SHA_PATTERN
from torchci.greenlight_decisions.rows import to_utc_naive
from torchci.greenlight_replay.policy import GIT_REF_PATTERN, Policy


__all__ = [
    "BOT_LOGIN_SUFFIX",
    "DIFF_FILENAME",
    "ESCAPE_SEQUENCE_FLAG",
    "ESCAPE_SEQUENCE_FLAG_MIN_VERSION",
    "EXCLUDED_LOGINS",
    "METADATA_FILENAME",
    "ReplayInputs",
    "build_inputs",
]

logger = logging.getLogger(__name__)

# The workflow writes both files to /tmp under these names and the prompt names them
# there, so a replay keeps the basenames and remaps only the directory.
DIFF_FILENAME = "greenlight-pr.diff"
METADATA_FILENAME = "greenlight-pr.json"

DIFF_ACCEPT_HEADER = "Accept: application/vnd.github.diff"

ESCAPE_SEQUENCE_FLAG = "--allow-escape-sequences"
# gh grew the flag in 2.97.0, alongside the CVE-2026-64654 fix that made a non-JSON
# body containing ESC an error even when stdout is redirected. Older gh rejects it as
# an unknown flag -- confirmed against 2.93.0 on 2026-09-18 -- so neither passing it
# unconditionally nor omitting it unconditionally works across both.
ESCAPE_SEQUENCE_FLAG_MIN_VERSION = (2, 97, 0)

METADATA_FIELDS = "number,title,body,comments"

BOT_LOGIN_SUFFIX = "[bot]"
EXCLUDED_LOGINS = frozenset({"pytorchmergebot", "facebook-github-bot"})

_GH_TIMEOUT_SECONDS = 180

_GH_VERSION_PATTERN = re.compile(r"(\d+)\.(\d+)\.(\d+)")


@dataclass(frozen=True)
class ReplayInputs:
    """Where one pull request's reviewer inputs landed, and what the gate made of them.

    ``metadata_path`` is ``None`` when the metadata could not be fetched, written or
    shaped. ``diff_lines`` and ``diff_bytes`` are reported whether or not the gate
    tripped, so a run's log says how far under or over the caps each PR sat.
    """

    diff_path: Path
    metadata_path: Path | None
    diff_lines: int
    diff_bytes: int
    too_large: bool


def build_inputs(
    repo: str,
    pr_number: int,
    base_ref: str,
    head_sha: str,
    comments_before: datetime,
    run_dir: Path,
    policy: Policy,
) -> ReplayInputs:
    """Fetch and write the reviewer's inputs for one pull request into ``run_dir``.

    ``base_ref`` is the PR's ``baseRefName``, not a SHA; ``head_sha`` is the commit the
    replayed verdict was pinned to, not the PR's current head.

    ``comments_before`` is the instant the replayed verdict was recorded. A naive value
    is read as UTC.

    A ``too_large`` result means the caller emits ``policy.too_large_verdict`` and runs
    no model, exactly as the workflow copies the canned file and skips the action step.
    """
    run_dir.mkdir(parents=True, exist_ok=True)

    diff = _fetch_diff(repo, base_ref, head_sha)
    diff_path = run_dir / DIFF_FILENAME
    diff_path.write_bytes(diff)

    # `wc -l` counts newlines rather than lines, so a diff whose final line is
    # unterminated counts one lower than it reads. The gate has to agree with CI on
    # that, not merely on the caps.
    diff_lines = diff.count(b"\n")
    diff_bytes = len(diff)
    too_large = diff_lines > policy.max_diff_lines or diff_bytes > policy.max_diff_bytes
    logger.info(
        "%s#%s diff is %d lines / %d bytes (caps: %d lines, %d bytes); %s",
        repo,
        pr_number,
        diff_lines,
        diff_bytes,
        policy.max_diff_lines,
        policy.max_diff_bytes,
        "declining automatically" if too_large else "proceeding with review",
    )

    metadata_path = _write_metadata(repo, pr_number, head_sha, comments_before, run_dir)
    return ReplayInputs(
        diff_path=diff_path,
        metadata_path=metadata_path,
        diff_lines=diff_lines,
        diff_bytes=diff_bytes,
        too_large=too_large,
    )


def _fetch_diff(repo: str, base_ref: str, head_sha: str) -> bytes:
    if not _REPO_PATTERN.fullmatch(repo):
        raise ValueError(f"refusing to build a compare endpoint from repo {repo!r}")
    if not GIT_REF_PATTERN.fullmatch(base_ref):
        raise ValueError(
            f"refusing to build a compare endpoint from base ref {base_ref!r}"
        )
    if not _SHA_PATTERN.fullmatch(head_sha):
        raise ValueError(f"refusing to build a compare endpoint from sha {head_sha!r}")

    argv = ["gh", "api", "-X", "GET"]
    if _escape_sequences_supported():
        argv.append(ESCAPE_SEQUENCE_FLAG)
    # The literal "repos/" prefix is security, not formatting, for the same reason it
    # is in greenlight_decisions.loc: `gh api` accepts an absolute URL and will send
    # the token to whatever host it names.
    argv += [
        "-H",
        DIFF_ACCEPT_HEADER,
        f"repos/{repo}/compare/{base_ref}...{head_sha}",
    ]

    completed = _run(argv)
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"gh api compare {repo} {base_ref}...{head_sha} exited "
            f"{completed.returncode}: {stderr[:400]}"
        )
    return completed.stdout


def _escape_sequences_supported() -> bool:
    """Whether the local gh takes ``--allow-escape-sequences``.

    Both wrong answers fail the fetch outright rather than corrupting it: an older gh
    rejects the flag as unknown, a newer one refuses a diff carrying ESC without it. A
    version that cannot be read is treated as older, which every gh before 2.97.0 is.
    """
    version = _gh_version()
    if version is None:
        logger.warning(
            "could not read the gh version; omitting %s", ESCAPE_SEQUENCE_FLAG
        )
        return False
    return version >= ESCAPE_SEQUENCE_FLAG_MIN_VERSION


@lru_cache(maxsize=1)
def _gh_version() -> tuple[int, int, int] | None:
    completed = _run(["gh", "--version"])
    if completed.returncode != 0:
        return None
    match = _GH_VERSION_PATTERN.search(completed.stdout.decode("utf-8", "replace"))
    if match is None:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _write_metadata(
    repo: str,
    pr_number: int,
    head_sha: str,
    comments_before: datetime,
    run_dir: Path,
) -> Path | None:
    try:
        payload = _fetch_pr(repo, pr_number)
        document = _metadata_document(payload, head_sha, comments_before)
        path = run_dir / METADATA_FILENAME
        # jq's default rendering: two-space indent, UTF-8 rather than \u escapes, and
        # a trailing newline. The file is model context, so matching it costs nothing
        # and removes one difference from the run being reproduced.
        path.write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        logger.info("wrote %s (comments: %d)", path, len(document["comments"]))
        return path
    except Exception:
        logger.exception(
            "could not collect PR metadata for %s#%s; the review runs without it",
            repo,
            pr_number,
        )
        return None


def _fetch_pr(repo: str, pr_number: int) -> dict[str, Any]:
    if not _REPO_PATTERN.fullmatch(repo):
        raise ValueError(f"refusing to read pull request metadata for repo {repo!r}")
    completed = _run(
        [
            "gh",
            "pr",
            "view",
            str(int(pr_number)),
            "--repo",
            repo,
            "--json",
            METADATA_FIELDS,
        ]
    )
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"gh pr view {repo}#{pr_number} exited {completed.returncode}: "
            f"{stderr[:400]}"
        )
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict):
        raise ValueError(f"gh pr view {repo}#{pr_number} did not return an object")
    return payload


def _metadata_document(
    payload: dict[str, Any], head_sha: str, comments_before: datetime
) -> dict[str, Any]:
    """The workflow's jq shape, key order included.

    ``head_sha`` is the pinned commit the verdict applies to, which is why it is
    injected rather than read from the payload: ``gh pr view`` reports the PR's current
    head, and on a landed PR that is no longer the head that was judged.
    """
    return {
        "number": payload.get("number"),
        "title": payload.get("title"),
        "body": payload.get("body"),
        "head_sha": head_sha,
        "comments": _comments(payload.get("comments") or [], comments_before),
    }


def _comments(
    raw: list[dict[str, Any]], comments_before: datetime
) -> list[dict[str, Any]]:
    cutoff = to_utc_naive(comments_before)
    kept: list[dict[str, Any]] = []
    for comment in raw:
        login = (comment.get("author") or {}).get("login") or ""
        folded = login.lower()
        if folded.endswith(BOT_LOGIN_SUFFIX) or folded in EXCLUDED_LOGINS:
            continue
        created_at = comment.get("createdAt")
        if not _predates(created_at, cutoff):
            continue
        kept.append(
            {
                "author": login,
                "body": comment.get("body"),
                "createdAt": created_at,
            }
        )
    return kept


def _predates(created_at: Any, cutoff: datetime) -> bool:
    if not isinstance(created_at, str):
        logger.warning("comment carries no createdAt; excluding it from the replay")
        return False
    try:
        parsed = datetime.fromisoformat(_normalize_utc_suffix(created_at))
    except ValueError:
        logger.warning("comment createdAt %r is not ISO-8601; excluding it", created_at)
        return False
    return to_utc_naive(parsed) < cutoff


def _normalize_utc_suffix(text: str) -> str:
    """Rewrite a trailing ``Z`` as ``+00:00`` before ``datetime.fromisoformat``.

    Only Python 3.11 and later parse the ``Z`` suffix, and every GitHub timestamp
    carries one. On an older interpreter every comment would fail to parse, be excluded
    by the fail-closed branch above, and the reviewer would silently receive no human
    comments at all -- a full-strength degradation reported only as one warning apiece.
    The repo's ruff target is still py38.

    ``greenlight_decisions.__main__.parse_as_of`` does the same rewrite for the same
    reason; see the note in that module about consolidating the two.
    """
    stripped = text.strip()
    if stripped.endswith(("Z", "z")):
        return stripped[:-1] + "+00:00"
    return stripped


def _run(argv: list[str]) -> subprocess.CompletedProcess[bytes]:
    """The one place this module spawns a process, and the tests' patch point.

    ``greenlight_decisions.loc._gh_api`` is the obvious thing to reuse and does not
    fit: it json-decodes the response and takes no header argument, so it can fetch
    neither a ``vnd.github.diff`` body nor anything else non-JSON.
    """
    return subprocess.run(
        argv, capture_output=True, check=False, timeout=_GH_TIMEOUT_SECONDS
    )
