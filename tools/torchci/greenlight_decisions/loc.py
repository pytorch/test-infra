"""Diff fetching and verdict staleness for the greenlight decision export.

Two numbers per pull request: ``loc``, the gross churn (added + removed lines) of
the diff, and ``sig_loc``, the same churn with blank lines, documentation files
and comment lines taken out. Both are measured at the head greenlight actually
judged, which is not always the head that shipped -- ``verdict_staleness`` says
which of the two cases a row is.

Counting one file's patch belongs to :mod:`.classify`, which is pure; this module
owns the GitHub reads, the per-row failure handling and the staleness comparison.
The classification names are re-exported here so callers have one import.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from typing import Any, Optional

from torchci.greenlight_decisions.classify import (
    classify_patch,
    classify_renamed_patch,
    COMMENT_PREFIXES_BY_BASENAME,
    COMMENT_PREFIXES_BY_EXTENSION,
    DOC_BASENAMES,
    DOC_EXTENSIONS,
    DOC_PATH_PREFIX,
    is_doc_path,
)


__all__ = [
    "classify_patch",
    "classify_renamed_patch",
    "COMMENT_PREFIXES_BY_BASENAME",
    "COMMENT_PREFIXES_BY_EXTENSION",
    "compute_loc",
    "DOC_BASENAMES",
    "DOC_EXTENSIONS",
    "DOC_PATH_PREFIX",
    "is_doc_path",
    "LOC_STATUS_BINARY_SKIPPED",
    "LOC_STATUS_MISSING_SHA",
    "LOC_STATUS_OK",
    "LOC_STATUS_PARSE_FAILED",
    "LOC_STATUS_TRUNCATED",
    "LOC_STATUSES_BY_SEVERITY",
    "STALENESS_CONTENT_CHANGED",
    "STALENESS_EXACT",
    "STALENESS_NOT_MEASURED",
    "STALENESS_REBASE_ONLY",
]

logger = logging.getLogger(__name__)

LOC_STATUS_OK = "ok"
LOC_STATUS_BINARY_SKIPPED = "binary_skipped"
LOC_STATUS_TRUNCATED = "truncated"
LOC_STATUS_MISSING_SHA = "missing_sha"
LOC_STATUS_PARSE_FAILED = "parse_failed"

# The whole domain of the loc_status column, least to most severe, so a consumer
# can write a filter against it from one place. Two placements are deliberate
# rather than incidental: missing_sha outranks the partial-measurement flags
# because nothing was measured at all behind it, and loses to parse_failed
# because an absent input is an expected data condition while a failed read is a
# fault -- a real failure must never be masked by a row that was never attempted.
LOC_STATUSES_BY_SEVERITY = (
    LOC_STATUS_OK,
    LOC_STATUS_BINARY_SKIPPED,
    LOC_STATUS_TRUNCATED,
    LOC_STATUS_MISSING_SHA,
    LOC_STATUS_PARSE_FAILED,
)
_STATUS_SEVERITY = {
    status: rank for rank, status in enumerate(LOC_STATUSES_BY_SEVERITY)
}
_UNKNOWN_STATUS = len(LOC_STATUSES_BY_SEVERITY)

STALENESS_EXACT = "exact"
STALENESS_REBASE_ONLY = "rebase-only"
STALENESS_CONTENT_CHANGED = "content-changed"
# Distinct from all three: the comparison could not be made. Spelling it
# "content-changed" would turn a GitHub outage into a repo-wide drift finding.
STALENESS_NOT_MEASURED = "not-measured"

_RENAME_STATUSES = frozenset({"renamed", "copied"})

HUNK_HEADER_PREFIX = "@@"

_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
_REPO_PATTERN = re.compile(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+")

# The compare endpoint returns at most 300 file entries and, unlike its
# ``commits`` array, that list does not paginate -- page 2 comes back empty. A
# response holding exactly the cap is therefore assumed clipped.
COMPARE_FILE_LIMIT = 300

_GH_TIMEOUT_SECONDS = 180


def compute_loc(
    repo: str,
    base_sha: str,
    judged_head_sha: str,
    final_head_sha: str,
) -> dict[str, Any]:
    """Measure the diff greenlight judged, and how far the final head drifted from it.

    Returns ``loc``, ``sig_loc``, ``verdict_staleness``,
    ``files_changed_after_verdict`` and ``loc_status``. Never raises, so one bad
    row cannot abort an export.

    Every numeric key is ``None`` rather than ``0`` when its value is unknown: a
    zero would read as an empty diff, or as a comparison that found no drift, to
    anyone reading the column without joining on ``loc_status``. Numbers that were
    measured survive a staleness comparison that then fails.
    """
    loc: Optional[int] = None
    sig_loc: Optional[int] = None
    loc_status = LOC_STATUS_OK
    judged_files: Optional[list[dict[str, Any]]] = None

    try:
        judged_files = _fetch_compare_files(repo, base_sha, judged_head_sha)
        loc, sig_loc, loc_status = _measure(judged_files)
    except Exception:
        logger.exception(
            "LOC measurement failed for %r %r...%r", repo, base_sha, judged_head_sha
        )
        loc, sig_loc, loc_status = None, None, LOC_STATUS_PARSE_FAILED

    try:
        staleness, files_changed = _measure_staleness(
            repo, base_sha, judged_files, judged_head_sha, final_head_sha
        )
    except Exception:
        logger.exception(
            "Verdict staleness check failed for %r %r...%r",
            repo,
            base_sha,
            final_head_sha,
        )
        # "Could not check" is not "it drifted". Both are non-coverage, only one
        # is a finding, and a GitHub outage must not report every row as drifted.
        staleness, files_changed = STALENESS_NOT_MEASURED, None
        loc_status = _worst_status(loc_status, LOC_STATUS_PARSE_FAILED)

    return {
        "loc": loc,
        "sig_loc": sig_loc,
        "verdict_staleness": staleness,
        "files_changed_after_verdict": files_changed,
        "loc_status": loc_status,
    }


def _worst_status(current: str, candidate: str) -> str:
    """The more severe of two statuses, ranked by ``LOC_STATUSES_BY_SEVERITY``.

    A status this module does not know outranks every one it does: ``__main__``
    mints its own, and treating an unrecognised status as benign would report a
    lost measurement as clean.
    """
    return max(
        current, candidate, key=lambda s: _STATUS_SEVERITY.get(s, _UNKNOWN_STATUS)
    )


def _measure(files: list[dict[str, Any]]) -> tuple[int, int, str]:
    loc = 0
    sig_loc = 0
    reported = 0
    status = LOC_STATUS_OK

    if len(files) >= COMPARE_FILE_LIMIT:
        logger.warning(
            "Compare returned %d files, at or above the %d cap; file list is clipped",
            len(files),
            COMPARE_FILE_LIMIT,
        )
        status = _worst_status(status, LOC_STATUS_TRUNCATED)

    for entry in files:
        path = entry["filename"]
        reported += entry.get("additions", 0) + entry.get("deletions", 0)

        entry_status = entry.get("status")
        patch = entry.get("patch")
        if patch is None:
            # Four different things arrive patchless and only one is a loss:
            #   changes > 0        GitHub withheld an oversized diff -> truncated
            #   renamed / copied   a pure rename, genuinely zero churn
            #   sha is null        a mode-only change, genuinely zero churn
            #   otherwise          a binary, whose size we cannot know
            # A chmod is otherwise indistinguishable from a binary on every field
            # here -- same status, same zero counts, same absent patch -- and
            # flagging it would discard a perfectly measured row.
            if entry.get("changes", 0):
                # %r, not %s: git permits a newline in a path and the compare API
                # returns it unescaped, so a PR author can otherwise forge a clean
                # log line in the operator's terminal.
                logger.warning(
                    "No patch for %r despite %d changes; diff too large to fetch",
                    path,
                    entry["changes"],
                )
                status = _worst_status(status, LOC_STATUS_TRUNCATED)
            elif entry_status not in _RENAME_STATUSES and entry.get("sha") is not None:
                status = _worst_status(status, LOC_STATUS_BINARY_SKIPPED)
            continue

        removed_path = path
        if entry_status in _RENAME_STATUSES:
            removed_path = entry.get("previous_filename") or path

        file_loc, file_sig_loc = classify_renamed_patch(patch, path, removed_path)
        loc += file_loc
        sig_loc += file_sig_loc

    if status != LOC_STATUS_TRUNCATED and loc != reported:
        logger.warning(
            "Counted %d changed lines but the compare reports %d; patch walk is off",
            loc,
            reported,
        )
        status = _worst_status(status, LOC_STATUS_PARSE_FAILED)

    return loc, sig_loc, status


def _strip_hunk_headers(patch: Optional[str]) -> Optional[str]:
    if patch is None:
        return None
    return "\n".join(
        line for line in patch.split("\n") if not line.startswith(HUNK_HEADER_PREFIX)
    )


def _base_side_path(entry: dict[str, Any]) -> str:
    """The path this file has in the base, which both compares share.

    Only a rename is followed back: a copy's source still exists on the head side
    and usually has its own entry, so sharing a key would drop one of the two.
    """
    if entry.get("status") == "renamed":
        return entry.get("previous_filename") or entry["filename"]
    return entry["filename"]


def _content_key(entry: dict[str, Any]) -> Optional[str]:
    """What two sides of one file are compared by.

    Hunk headers are stripped from the patch because a rebase over a base that
    grew shifts every ``@@`` position without touching a character of content,
    which would report a byte-identical diff as content-changed. Only the
    positions go: every added, removed and context line still compares byte for
    byte, so a hunk that gained or lost a line still differs.

    A patchless entry falls back to the head blob sha, which is content-addressed
    and so is stable across a pure rebase. Comparing patchless entries by their
    absent patch made every binary equal to every other binary and reported two
    genuinely different blobs as rebase-only. The fallback is deliberately not
    used where a patch exists, and a mode-only change correctly keys on ``None``
    at both ends because its blob really is unchanged.
    """
    patch = entry.get("patch")
    if patch is not None:
        return _strip_hunk_headers(patch)
    return entry.get("sha")


def _patch_map(files: list[dict[str, Any]]) -> dict[str, tuple[str, Optional[str]]]:
    """Map each file's base-side path to its head-side path and content key.

    Keying on the base keeps a file renamed between the two heads as one entry
    rather than a disappearance and an arrival counted as two; the head-side path
    rides along in the value so the rename itself still reads as a change.
    """
    mapping = {
        _base_side_path(entry): (entry["filename"], _content_key(entry))
        for entry in files
    }
    if len(mapping) != len(files):
        logger.warning(
            "Compare returned %d files but only %d distinct base-side paths; "
            "a staleness comparison over collapsed entries may be wrong",
            len(files),
            len(mapping),
        )
    return mapping


def _measure_staleness(
    repo: str,
    base_sha: str,
    judged_files: Optional[list[dict[str, Any]]],
    judged_head_sha: str,
    final_head_sha: str,
) -> tuple[str, int]:
    if judged_head_sha == final_head_sha:
        return STALENESS_EXACT, 0
    if judged_files is None:
        raise RuntimeError(
            f"judged diff for {repo} {base_sha}...{judged_head_sha} is unavailable, "
            "so it cannot be compared against the final head"
        )

    final_files = _fetch_compare_files(repo, base_sha, final_head_sha)
    judged_patches = _patch_map(judged_files)
    final_patches = _patch_map(final_files)

    differing = [
        path
        for path in judged_patches.keys() | final_patches.keys()
        if judged_patches.get(path) != final_patches.get(path)
    ]
    if not differing:
        return STALENESS_REBASE_ONLY, 0
    return STALENESS_CONTENT_CHANGED, len(differing)


def _fetch_compare_files(
    repo: str, base_sha: str, head_sha: str
) -> list[dict[str, Any]]:
    # Validated here rather than at the caller because this is where the endpoint
    # is built: a value carrying "?" or "#" would silently redirect the request to
    # a different endpoint and return a plausible wrong answer.
    if not _REPO_PATTERN.fullmatch(repo):
        raise ValueError(f"refusing to build a compare endpoint from repo {repo!r}")
    for sha in (base_sha, head_sha):
        if not _SHA_PATTERN.fullmatch(sha):
            raise ValueError(f"refusing to build a compare endpoint from sha {sha!r}")

    # The literal "repos/" prefix is load-bearing security, not formatting. `gh
    # api` accepts an absolute URL and will send the token to whatever host it
    # names -- verified fetching example.com. Keep the path relative and rooted
    # here; making it fully caller-supplied turns this into token exfiltration.
    payload = _gh_api(f"repos/{repo}/compare/{base_sha}...{head_sha}")
    return payload.get("files") or []


def _gh_api(path: str) -> dict[str, Any]:
    completed = subprocess.run(
        ["gh", "api", "-X", "GET", path],
        capture_output=True,
        check=False,
        timeout=_GH_TIMEOUT_SECONDS,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"gh api GET {path} exited {completed.returncode}: {stderr[:400]}"
        )
    return json.loads(completed.stdout)
