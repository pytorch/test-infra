"""What one tick's steps came to, and how the tick shares its dispatch cap between the repos.

``Outcomes.attempt`` runs one step of a repo's work and sorts how it ended: ``RepoBudgetExceeded`` is a
cut; ``RateLimitStop``, or any failure ``github_client.is_rate_limit_error`` recognises, sets the
tick's latch; any other ``IterationTimeout`` propagates and aborts the tick; anything else is logged
with its traceback and becomes the repo's error. A cut or a missed turn is the repo's error when its
full tick was due, and a warning otherwise.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal

from greenlight import github_client
from greenlight.constants import DISPATCH_RESERVE
from greenlight.guards import IterationTimeout
from greenlight.quota import RateLimitStop, RepoBudgetExceeded

if TYPE_CHECKING:
    from collections.abc import Callable

    from greenlight.quota import TickMeter

logger = logging.getLogger(__name__)

RATE_LIMITED = "a rate limit stopped this tick's GitHub work"

Outcome = Literal["done", "cut", "rate limit", "failed"]


class Outcomes:
    """One tick's errors, in the order found, and its rate-limit latch (``tick.latch``)."""

    def __init__(self, tick: TickMeter) -> None:
        self.tick = tick
        self.errors: list[str] = []

    def error(self, repo: str, message: str) -> None:
        logger.error("%s: %s", repo, message)
        self.errors.append(f"{repo}: {message}")

    def shortfall(self, repo: str, message: str, *, full_tick_due: bool) -> None:
        """A cut or a missed turn: an error when the repo's full tick was due, else a warning."""
        if full_tick_due:
            self.error(repo, f"{message}; its full tick did not fit")
        else:
            logger.warning("%s: %s; its PRs wait for the next tick", repo, message)

    def skipped(self, repo: str, phase: str) -> bool:
        """True, recorded as the repo's error, once a rate limit has stopped the tick's GitHub work."""
        if not self.tick.latch.is_set():
            return False
        self.error(repo, f"{phase} skipped: {RATE_LIMITED}")
        return True

    def rate_limited(self, repo: str, step: str) -> None:
        self.tick.latch.set()
        self.error(repo, f"{step} stopped: {RATE_LIMITED}")

    def attempt(self, repo: str, step: str, work: Callable[[], object], *, full_tick_due: bool = True) -> Outcome:
        """Run one step of ``repo``'s work and record how it ended."""
        try:
            work()
        except RepoBudgetExceeded as exc:
            reason = self.tick.meter(repo).stopped or str(exc)
            self.shortfall(repo, f"{step} cut short: {reason}", full_tick_due=full_tick_due)
            return "cut"
        except RateLimitStop:
            self.rate_limited(repo, step)
            return "rate limit"
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                self.rate_limited(repo, step)
                return "rate limit"
            logger.exception("%s: %s failed", repo, step)
            self.errors.append(f"{repo}: {step} failed: {exc}")
            return "failed"
        return "done"


class DispatchShare:
    """The tick's ``--max`` across its repos.

    With no cap every repo is uncapped. Otherwise ``min(DISPATCH_RESERVE, max)`` is held back from the
    primary while another repo is in Phase B, and the other repos share it plus whatever the primary
    left, in order, each capped by what is left. A negative cap counts as zero.
    """

    def __init__(self, max_dispatches: int | None, *, others: bool) -> None:
        self._left = None if max_dispatches is None else max(0, max_dispatches)
        self._reserve = 0 if self._left is None or not others else min(DISPATCH_RESERVE, self._left)

    def primary(self) -> int | None:
        return None if self._left is None else self._left - self._reserve

    def left(self) -> int | None:
        return self._left

    def spend(self, dispatched: int) -> None:
        if self._left is not None:
            self._left = max(0, self._left - dispatched)
