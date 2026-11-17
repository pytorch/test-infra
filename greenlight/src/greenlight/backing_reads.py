"""One tick's reads of a ``gate`` repo's PRs for the approval-backing check (``approval_backing``).

``TickReads`` reads each PR's GreenLight reviews at most once a tick, judges every live approval with
``backing_judge.judge`` on the tick's ledger, rules and clock, and dismisses the unbacked ones after judging them
again on a fresh read of the PR. A read whose judgement settles stores the PR's key in the memory's; a PR judged
waiting or unknown joins ``waiting``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import approvals, backing_judge, github_client
from greenlight.constants import IN_FLIGHT_STATUSES
from greenlight.guards import IterationTimeout
from greenlight.ineligible_approvals import dismiss_each

if TYPE_CHECKING:
    import threading
    from collections.abc import Iterable
    from datetime import datetime

    from github import Github
    from github.PullRequest import PullRequest

    from greenlight.approvals import PullFacts, ReviewReader, ReviewRecord
    from greenlight.backing_judge import Judgement
    from greenlight.gate_rules import GateRules
    from greenlight.scan_memory import BackingKey, DrainPass
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_DISMISS_MESSAGE = "GreenLight's approval no longer applies"
_UNSETTLED = frozenset({"waiting", "unknown"})


@dataclass(frozen=True, slots=True)
class Ledger:
    """The tick's ClickHouse reads: each PR's latest non-shadow row and verdict, and the ledger's newest version."""

    gates: dict[int, PRState]
    verdicts: dict[int, PRState]
    newest: datetime | None

    def drives(self, number: int) -> bool:
        """Whether ``number`` is a ledger PR: it has a verdict, or its latest row is in flight."""
        row = self.gates.get(number)
        return number in self.verdicts or (row is not None and row.status in IN_FLIGHT_STATUSES)


@dataclass
class TickReads:
    """One tick's reads and dismissals on a gate repo; every judgement uses the tick's ledger, rules and clock.

    ``ledger`` is None when it could not be read. ``keys`` holds each open PR's key this tick; ``kept`` is the
    memory's, where a settled read stores its PR's key.
    """

    repo: str
    client: Github
    reader: ReviewReader
    sweep: DrainPass
    pulls: dict[int, PullRequest]
    ledger: Ledger | None
    rules: GateRules | None
    keys: dict[int, BackingKey]
    kept: dict[int, BackingKey]
    now: datetime
    bot_login: str
    cancel_event: threading.Event
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

    def read_all(self, numbers: Iterable[int]) -> int:
        """Check each PR in ``numbers`` not tried yet this tick, until a rate limit; how many it tried."""
        tried = 0
        for number in numbers:
            if self.cancel_event.is_set():
                break
            if number in self.tried:
                continue
            self.read(number)
            tried += 1
        return tried

    def read(self, number: int) -> None:
        self.tried.add(number)
        self.sweep.attempt(number)
        try:
            reviews = self.reader.reviews(self.repo, number)
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                self.cancel_event.set()
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
        if number not in self.waiting:
            self.kept[number] = self.keys[number]
        self.checked.add(number)
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
