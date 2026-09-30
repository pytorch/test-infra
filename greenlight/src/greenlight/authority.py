"""Whose evaluation in one scan carries authority, judged from the trusted-authors issue's list.

``log_unnamed_listed`` flags listed logins no merge rule names; ``covering_rule`` asks
``cohort.assess`` about one PR and logs the answer whenever its author is listed in the issue.
``Authority`` answers ``shadow_for_pr`` for one pass, lazily and at most once per PR: only a PR the
revert guard, the dial exemption or dispatch asks about is worth a files read, so a catch-all author
and a PR nobody asks about cost no GitHub call. It also answers the stamp for a REVERTED row, the one
row that denies, keeping it visible on a recorded PR whose author is currently listed, and it defers
a candidate whose head moved after its authority was read. The memo is unlocked and the files read
borrows the scan's main client, so it is asked from the main thread only.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, NamedTuple, Protocol

from greenlight import cohort
from greenlight.github_client import is_rate_limit_error
from greenlight.guards import IterationTimeout
from greenlight.merge_authz import changed_files

if TYPE_CHECKING:
    import threading
    from collections.abc import Callable, Collection, Mapping, Sequence

    from greenlight.cohort import EligibilityRule
    from greenlight.github_types import _FilesPR

logger = logging.getLogger(__name__)


class _ReadSkipped(Exception):
    """A files read not attempted because a rate limit already tripped the pass's cancel event."""


class _Fingerprinted(Protocol):
    @property
    def pr_number(self) -> int: ...
    @property
    def head_sha(self) -> str: ...


class Target(NamedTuple):
    """The ``--pr`` target as its gate judged it; ``head_sha`` is set only when its files were read.

    A ``refused`` target is never fingerprinted or dispatched; it only reaches the revert guard.
    """

    number: int
    author: str | None
    shadow: bool
    head_sha: str | None
    refused: bool = False


def is_listed(login: str | None, listed: frozenset[str]) -> bool:
    return login is not None and login.lower() in listed


def log_unnamed_listed(listed: frozenset[str], rules: Sequence[EligibilityRule]) -> None:
    """Warn about listed logins no merge rule names in any casing: none of their PRs can be authoritative."""
    named = {approver.lower() for rule in rules for approver in rule.approvers}
    unnamed = sorted(listed - named)
    if unnamed:
        logger.warning("trusted-authors issue lists %d login(s) that no merge rule names: %s", len(unnamed), unnamed)


def covering_rule(
    number: int,
    login: str | None,
    listed: frozenset[str],
    rules: Sequence[EligibilityRule],
    files: Callable[[], Sequence[str] | None],
) -> EligibilityRule | None:
    """``cohort.assess`` for PR ``number``, logging its reason whenever the author is listed."""
    rule, reason = cohort.assess(login, listed, rules, files)
    if is_listed(login, listed):
        logger.info("PR #%d by %s: %s", number, login, reason)
    return rule


class Authority:
    """The scan's ``shadow_for_pr``: a PR is shadow unless its author, listed in the issue, is eligible for it.

    ``authors`` maps each PR from the listing to its author; a number outside it is shadow. ``target``
    seeds the ``--pr`` gate's answer, which is never re-read. A PR whose files read fails is shadow and
    undetermined, and recorded in ``failed`` so the pass still fails; a rate limit also trips
    ``cancel_event``, after which reads are skipped and the PR is undetermined and ``abandoned``
    instead. The caller drops every ``undetermined`` PR before fingerprint and dispatch.
    """

    def __init__(
        self,
        *,
        listed: frozenset[str],
        rules: Sequence[EligibilityRule],
        authors: Mapping[int, str | None],
        fetch_pr: Callable[[int], _FilesPR],
        failed: list[int],
        cancel_event: threading.Event,
        recorded: Collection[int],
        target: Target | None = None,
    ) -> None:
        self._listed = listed
        self._rules = rules
        self._authors = dict(authors)
        self._fetch_pr = fetch_pr
        self._failed = failed
        self._cancel_event = cancel_event
        self._recorded = recorded
        self._memo: dict[int, bool] = {}
        self._heads: dict[int, str] = {}
        self._undetermined: set[int] = set()
        self._abandoned: set[int] = set()
        if target is not None:
            self._authors[target.number] = target.author
            self._memo[target.number] = target.shadow
            if target.head_sha is not None:
                self._heads[target.number] = target.head_sha

    @property
    def undetermined(self) -> frozenset[int]:
        return frozenset(self._undetermined)

    @property
    def abandoned(self) -> frozenset[int]:
        return frozenset(self._abandoned)

    def shadow(self, number: int) -> bool:
        memoized = self._memo.get(number)
        if memoized is not None:
            return memoized
        if number not in self._authors:
            return True
        answer = self._decide(number)
        self._memo[number] = answer
        return answer

    def reverted_shadow(self, number: int) -> bool:
        """``shadow`` for a REVERTED row, which stays visible on a recorded PR whose author is listed.

        A shadow REVERTED row is invisible to Dr. CI and the land gate, which then keep reading any
        authoritative row beneath it, and a REVERTED row can only deny. A listed author's recorded PR
        therefore gets a non-shadow one whatever its files show now, so they are never read for it.
        """
        if number in self._recorded and is_listed(self._authors.get(number), self._listed):
            return False
        return self.shadow(number)

    def dispatchable[C: _Fingerprinted](self, pending: Sequence[C]) -> list[C]:
        """The candidates to dispatch: each one fingerprinted at the head its authority was read at.

        A push between the two reads would otherwise dispatch a head whose authority nobody decided, so
        such a candidate is deferred to the next pass, which reads it afresh. It is neither failed nor
        abandoned. Only heads are compared: a retarget between the two reads is not caught here.
        """
        kept: list[C] = []
        for candidate in pending:
            read_at = self._heads.get(candidate.pr_number)
            if read_at is not None and read_at != candidate.head_sha:
                logger.warning(
                    "PR #%d: fingerprinted at %s but its authority was read at %s; deferred to the next pass",
                    candidate.pr_number,
                    candidate.head_sha,
                    read_at,
                )
                continue
            kept.append(candidate)
        return kept

    def _decide(self, number: int) -> bool:
        def files() -> tuple[str, ...] | None:
            if self._cancel_event.is_set():
                raise _ReadSkipped
            pr = self._fetch_pr(number)
            self._heads[number] = pr.head.sha
            return changed_files(pr)

        try:
            rule = covering_rule(number, self._authors[number], self._listed, self._rules, files)
        except IterationTimeout:
            raise
        except _ReadSkipped:
            logger.info("PR #%d: files read skipped after a rate limit; not dispatched this pass", number)
            self._abandoned.add(number)
        except Exception as exc:
            if is_rate_limit_error(exc):
                self._cancel_event.set()
            logger.error(
                "failed to read the changed files of PR #%d; shadow and not dispatched this pass: %s",
                number,
                exc,
                exc_info=True,
            )
            self._failed.append(number)
        else:
            return rule is None
        self._undetermined.add(number)
        return True
