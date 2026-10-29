"""A GitHub stack's context, rebuilt best effort as of the replayed verdict's cutoff.

The stack step pinned by :data:`.stack_step.STEP_SHA256` gives a pull request in a
GitHub stack the open pull requests of its author among the five entries directly
above it, each diffed from the head of the entry below it. GitHub keeps no record of a
stack's past membership, so this starts from the stack as it stands today: of those
five entries, it keeps each one that existed and was open at the cutoff, by the same
author. Heads are the ones at the cutoff: the replayed head for this pull request, and
for an entry its newest commit dated at or before the cutoff, by
:func:`.stack._head_at`'s rules. An entry whose head then is unknown is skipped and
logged, and so is the one above it, which then has no base. Any other fault raises, as
for a ghstack.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from torchci.greenlight_replay.stack import (
    _at_cutoff_fields,
    _graphql,
    _head_at,
    _instant,
    _open_at,
    _repo_variables,
    _siblings,
    _write_files,
    HeadUnknown,
)
from torchci.greenlight_replay.stack_step import SIBLINGS_ABOVE


__all__ = ["write_native_stack"]

logger = logging.getLogger(__name__)

_STACK_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title author { login }
      stack {
        entries(first: 100) {
          totalCount pageInfo { hasNextPage } nodes { position pullRequest { number } }
        }
      }
    }
  }
}
"""

# Only a force-push of an entry's head after the cutoff hides its head then: the diff
# starts from the head of the entry below, never from the entry's own base.
_ENTRY_FIELDS = "title author { login } " + _at_cutoff_fields(
    "HEAD_REF_FORCE_PUSHED_EVENT"
)


def write_native_stack(
    repo: str, pr_number: int, cutoff: datetime, run_dir: Path, head_sha: str
) -> Path | None:
    """The stack JSON for ``repo#pr_number``'s GitHub stack, or None outside one.

    ``cutoff`` is naive UTC and ``head_sha`` is the head the replayed verdict judged.
    """
    variables = _repo_variables(repo, number=pr_number)
    pull = _graphql(_STACK_QUERY, variables)["repository"]["pullRequest"]
    if pull["stack"] is None:
        logger.info("%s#%s is in no stack; no stack context", repo, pr_number)
        return None
    above = _above(pull["stack"]["entries"], pr_number)
    entries = _siblings(repo, above, cutoff, _ENTRY_FIELDS) if above else {}
    author = (pull["author"] or {}).get("login")
    kept: list[tuple[int, str, str, str]] = []
    below: str | None = head_sha
    for number in above:
        entry = entries[number]
        head = _head_at_or_none(number, entry, cutoff)
        if below is None:
            logger.info("skipping #%s: the head below it is unknown", number)
        elif author is None or (entry["author"] or {}).get("login") != author:
            logger.info("skipping #%s: not by this PR's author, %s", number, author)
        elif not _open_at(entry, cutoff):
            logger.info("skipping #%s: not open at the cutoff", number)
        elif head is not None:
            kept.append((number, entry["title"], below, head))
        below = head
    return _write_files(repo, run_dir, kept[::-1], (pr_number, pull["title"]))


def _above(entries: dict[str, Any], pr_number: int) -> list[int]:
    """The up to five entries directly above ``pr_number`` today, nearest first.

    Incomplete entries raise, as the step fails on them, null ones included, and so does
    a stack that does not list ``pr_number`` exactly once.
    """
    nodes = entries["nodes"]
    if (
        entries["pageInfo"]["hasNextPage"]
        or entries["totalCount"] != len(nodes)
        or any(node is None or node["pullRequest"] is None for node in nodes)
    ):
        raise ValueError("the stack's entries are incomplete")
    ordered = sorted(nodes, key=lambda node: node["position"])
    numbers = [node["pullRequest"]["number"] for node in ordered]
    if not all(type(number) is int and number > 0 for number in numbers):
        raise ValueError(f"the stack lists {numbers!r:.200}, not PR numbers")
    if numbers.count(pr_number) != 1:
        raise ValueError(
            f"the stack lists #{pr_number} {numbers.count(pr_number)} times"
        )
    at = numbers.index(pr_number)
    return numbers[at + 1 : at + 1 + SIBLINGS_ABOVE]


def _head_at_or_none(
    number: int, entry: dict[str, Any], cutoff: datetime
) -> str | None:
    """The entry's head at the cutoff, or None, logged, when it cannot be known."""
    if _instant(entry["createdAt"]) > cutoff:
        logger.info("#%s has no head at the cutoff: it was opened after it", number)
        return None
    try:
        return _head_at(number, entry, cutoff)
    except HeadUnknown as unknown:
        logger.info("#%s has no knowable head at the cutoff: %s", number, unknown)
        return None
