"""One run's reads of a ``gate`` repo's PRs for the approval-backing check (``approval_backing``).

``TickReads`` reads each PR's GreenLight reviews at most once a run, judges every live approval with
``backing_judge.judge`` on the run's ledger, rules and clock, and dismisses the unbacked ones after judging them
again on a fresh read of the PR. A read whose judgement settles stores the PR's key in the memory's; a PR judged
waiting or unknown, or read while the rules answer is unknown, joins ``waiting``, so it is judged again once the
rules can be read. A rate limit sets ``cancel_event`` through ``latch.latch_rate_limit``, keeping the wait the
response asked for.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import approvals, backing_judge, github_client
from greenlight.constants import IN_FLIGHT_STATUSES
from greenlight.guards import IterationTimeout
from greenlight.ineligible_approvals import dismiss_each
from greenlight.latch import latch_rate_limit

if TYPE_CHECKING:
    import threading
    from collections.abc import Callable, Iterable
    from datetime import datetime

    from github import Github
    from github.PullRequest import PullRequest

    from greenlight.approvals import PullFacts, ReviewReader, ReviewRecord
    from greenlight.backing_judge import Judgement
    from greenlight.backing_memory import BackingKey
    from greenlight.drain_pass import DrainPass
    from greenlight.gate_rules import GateRules
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_DISMISS_MESSAGE = "GreenLight's approval no longer applies"
_UNSETTLED = frozenset({"waiting", "unknown"})


@dataclass(frozen=True, slots=True)
class Ledger:
    """The run's ClickHouse reads: each PR's latest non-shadow row and verdict, and the ledger's newest version."""

    gates: dict[int, PRState]
    verdicts: dict[int, PRState]
    newest: datetime | None

    def drives(self, number: int) -> bool:
        """Whether ``number`` is a ledger PR: it has a verdict, or its latest row is in flight."""
        row = self.gates.get(number)
        return number in self.verdicts or (row is not None and row.status in IN_FLIGHT_STATUSES)


@dataclass
class TickReads:
    """One run's reads and dismissals on a gate repo; every judgement uses the run's ledger, rules and clock.

    ``sweep`` is None when the run sweeps nothing (a ``shadow`` entry). ``ledger`` is None when it could not be
    read, ``rules`` when they could not. ``keys`` holds each open PR's key this run; ``kept`` is the memory's,
    where a settled read stores its PR's key. ``monotonic`` is the clock ``read_all``'s ``until`` is on.
    """

    repo: str
    client: Github
    reader: ReviewReader
    sweep: DrainPass | None
    pulls: dict[int, PullRequest]
    ledger: Ledger | None
    rules: GateRules | None
    keys: dict[int, BackingKey]
    kept: dict[int, BackingKey]
    now: datetime
    bot_login: str
    cancel_event: threading.Event
    monotonic: Callable[[], float]
    tried: set[int] = field(default_factory=set)
    checked: set[int] = field(default_factory=set)
    waiting: set[int] = field(default_factory=set)
    failed: list[int] = field(default_factory=list)
    dismissed: int = 0

    def judge(self, approval: ReviewRecord, number: int, head: str, base: str) -> Judgement:
        ledger = self.ledger
        return backing_judge.judge(
            approval,
            repo=self.repo,
            head=head,
            base=base,
            gate=None if ledger is None else ledger.gates.get(number),
            rules=self.rules,
            ledger_newest=None if ledger is None else ledger.newest,
            now=self.now,
            ledger_known=ledger is not None,
        )

    def read_all(self, numbers: Iterable[int], *, until: float | None = None) -> list[int]:
        """Check each PR in ``numbers`` not tried yet this run, until a rate limit, or until ``monotonic`` reaches
        ``until`` (None: no limit) before a read; the PRs it tried, in order."""
        tried: list[int] = []
        for number in numbers:
            if self.cancel_event.is_set() or (until is not None and self.monotonic() >= until):
                break
            if number in self.tried:
                continue
            self.read(number)
            tried.append(number)
        return tried

    def read(self, number: int) -> None:
        self.tried.add(number)
        if self.sweep is not None:
            self.sweep.attempt(number)
        try:
            reviews = self.reader.reviews(self.repo, number)
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                latch_rate_limit(self.cancel_event, exc)
            logger.error("%s: cannot read GreenLight's reviews on PR #%d: %s", self.repo, number, exc, exc_info=True)
            self.failed.append(number)
            return
        pull = self.pulls[number]
        judged = {
            self.judge(approval, number, pull.head.sha, pull.base.ref).state
            for approval in approvals.live_approvals(reviews, self.bot_login)
        }
        if "unbacked" in judged:
            if not self.dismiss(number, reviews):
                return
        elif judged & _UNSETTLED:
            self.waiting.add(number)
        if self.rules is None:
            self.waiting.add(number)
        if number not in self.waiting:
            self.kept[number] = self.keys[number]
        self.checked.add(number)
        if self.sweep is not None:
            self.sweep.checked.add(number)

    def dismiss(self, number: int, reviews: list[ReviewRecord]) -> bool:
        """Judge the live approvals again on a fresh read of the PR and dismiss the unbacked ones; False on failure."""

        def dismiss_unbacked(fresh: PullFacts, *, bot_login: str, message: str) -> list[int]:
            dismissed: list[int] = []
            for approval in approvals.live_approvals(reviews, bot_login):
                judgement = self.judge(approval, number, fresh.head_sha, fresh.base_ref)
                if judgement.state in _UNSETTLED:
                    self.waiting.add(number)
                elif judgement.state == "unbacked":
                    approvals.dismiss_review(
                        self.client.requester, self.repo, number, approval.id, f"{message}: {judgement.reason}."
                    )
                    self.dismissed += 1
                    dismissed.append(approval.id)
            return dismissed

        outcome = dismiss_each(
            self.client,
            [number],
            repo=self.repo,
            bot_login=self.bot_login,
            message=_DISMISS_MESSAGE,
            why=f"in {self.repo}, as no LAND row backs it",
            get_pr=lambda _client, repo, pr: self.reader.pull(repo, pr),
            dismiss=dismiss_unbacked,
            failed=self.failed,
            cancel_event=self.cancel_event,
        )
        return number in outcome
