"""Dispatch the review scan's candidates and record each dispatch.

The ``--max`` cap goes to the stalest candidates first. A dispatched PR gets an
``AI_REVIEW_DISPATCHED`` marker row and, once that row is written and unless the PR is shadow, a
Dr. CI poke.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol

from greenlight import constants
from greenlight.guards import IterationTimeout
from greenlight.scan_runner import _staleness_key_for_state
from greenlight.state import next_run_id

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from github import Github

    from greenlight.scan_runner import _Candidate

    class DispatchFn(Protocol):
        # Everything but shadow is positional-only so injected test doubles needn't match the
        # parameter names; shadow is keyword-only and has no default, so no caller can dispatch a
        # review without stating which cohort the PR belongs to.
        def __call__(
            self, client: Github, pr_number: int, head_sha: str, eval_hash: str, ref: str, /, *, shadow: bool
        ) -> None: ...


logger = logging.getLogger(__name__)


def _emit_dispatch_marker(
    candidate: _Candidate, emit_dispatched: Callable[..., None], poke: Callable[[int], None], *, shadow: bool
) -> None:
    # The workflow was already fired, so an emit failure is logged and swallowed: a missing marker
    # self-heals (next scan re-dispatches, the reviewer's per-PR concurrency group cancels the dup),
    # and must not fail the scan or block dispatching the remaining candidates.
    try:
        emit_dispatched(
            repo=constants.TARGET_REPO,
            pr_number=candidate.pr_number,
            head_sha=candidate.head_sha,
            eval_hash=candidate.eval_hash,
            run_id=next_run_id(candidate.state),
            shadow=shadow,
        )
    except IterationTimeout:
        raise
    except Exception as exc:
        logger.error(
            "failed to emit AI_REVIEW_DISPATCHED marker for PR #%d: %s", candidate.pr_number, exc, exc_info=True
        )
    else:
        # Success arm only: Dr. CI rebuilds its comment from the row this emit just wrote, so poking
        # after a failed emit would re-render the very state the marker was meant to replace. A
        # shadow row is filtered out of that query, so a rebuild has nothing to pick up and the poke
        # is skipped.
        if not shadow:
            poke(candidate.pr_number)


def _staleness_key(candidate: _Candidate) -> tuple[bool, datetime]:
    return _staleness_key_for_state(candidate.state)


def _dispatch_pending(
    client: Github,
    pending: list[_Candidate],
    *,
    ref: str,
    max_dispatches: int | None,
    dispatch: DispatchFn,
    emit_dispatched: Callable[..., None],
    poke: Callable[[int], None],
    shadow_for_pr: Callable[[int], bool],
) -> list[int]:
    ordered = sorted(pending, key=_staleness_key)
    limit = len(ordered) if max_dispatches is None else max(0, max_dispatches)
    dispatch_failed: list[int] = []
    for candidate in ordered[:limit]:
        # Resolved once per candidate so the workflow input, the marker row, and the poke decision
        # can never disagree about which cohort this PR is in.
        shadow = shadow_for_pr(candidate.pr_number)
        try:
            dispatch(client, candidate.pr_number, candidate.head_sha, candidate.eval_hash, ref, shadow=shadow)
        except IterationTimeout:
            raise
        except Exception as exc:
            logger.error("failed to dispatch review for PR #%d: %s", candidate.pr_number, exc, exc_info=True)
            dispatch_failed.append(candidate.pr_number)
            continue
        logger.info("dispatched review for PR #%d (%s)", candidate.pr_number, candidate.reason)
        _emit_dispatch_marker(candidate, emit_dispatched, poke, shadow=shadow)
    for candidate in ordered[limit:]:
        logger.info("deferred PR #%d dispatch: --max cap reached", candidate.pr_number)
    return dispatch_failed
