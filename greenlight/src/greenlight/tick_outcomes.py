"""What one scan invocation's steps came to.

``Outcomes.attempt`` runs one step of a repo's work and sorts how it ended: ``RepoBudgetExceeded`` is a
cut; ``RateLimitStop`` means the latch was already set, and any failure ``github_client.is_rate_limit_error``
recognises sets it, with until when its response asked to wait; any other ``IterationTimeout`` propagates
and aborts the invocation; anything else is logged with its traceback and becomes the repo's error. A
cut or a missed turn is the repo's error when its full tick was due, and a warning otherwise; the PRs a
repo's Phase B failed on before a cut or a rate limit stopped it are always its error, whether or not its
full tick was due (``failed_before``). A latch set by work that absorbed the rate limit, with nothing
after it to skip, is still named in the errors (``name_the_rate_limit``).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal, TypeVar

from greenlight import github_client
from greenlight.guards import IterationTimeout
from greenlight.quota import RateLimitStop, RepoBudgetExceeded, rate_limit_headers

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from greenlight.quota import TickMeter

logger = logging.getLogger(__name__)

RATE_LIMITED = "a rate limit stopped this invocation's GitHub work"

Outcome = Literal["done", "cut", "rate limit", "failed"]
_T = TypeVar("_T")


class Outcomes:
    """One invocation's errors, in the order found, and its rate-limit latch (``tick.latch``)."""

    def __init__(self, tick: TickMeter) -> None:
        self.tick = tick
        self.errors: list[str] = []

    def error(self, repo: str, message: str) -> None:
        logger.error("%s: %s", repo, message)
        self.errors.append(f"{repo}: {message}")

    def problem(self, message: str) -> None:
        """An error of the invocation itself, not of one repo."""
        logger.error("%s", message)
        self.errors.append(message)

    def shortfall(self, repo: str, message: str, *, full_tick_due: bool) -> None:
        """A cut or a missed turn: an error when the repo's full tick was due, else a warning."""
        if full_tick_due:
            self.error(repo, f"{message}; its full tick did not fit")
        else:
            logger.warning("%s: %s; its PRs wait for the next tick", repo, message)

    def skipped(self, repo: str, phase: str) -> bool:
        """True, recorded as the repo's error, once a rate limit has stopped the invocation's GitHub work."""
        if not self.tick.latch.is_set():
            return False
        self.error(repo, f"{phase} skipped: {RATE_LIMITED}")
        return True

    def rate_limited(self, repo: str, step: str, exc: BaseException) -> None:
        """Record ``step`` as stopped by the rate limit ``exc``, setting the latch for it."""
        self.tick.note_rate_limit(rate_limit_headers(exc))
        self.error(repo, f"{step} stopped: {RATE_LIMITED}")

    def failed_before(self, repo: str, outcome: Outcome, failed: Iterable[int]) -> None:
        """Record, as the repo's error, the PRs its Phase B failed on before a cut or a rate limit stopped it."""
        found = sorted(set(failed))
        if found and outcome in ("cut", "rate limit"):
            self.error(repo, f"Phase B failed on {len(found)} PR(s) before it stopped: {found}")

    def name_the_rate_limit(self) -> None:
        """Record the rate limit as an error when the latch is set and no error names it yet."""
        if self.tick.latch.is_set() and not any(RATE_LIMITED in error for error in self.errors):
            logger.error("%s", RATE_LIMITED)
            self.errors.append(RATE_LIMITED)

    def attempt(self, repo: str, step: str, work: Callable[[], object], *, full_tick_due: bool = True) -> Outcome:
        """Run one step of ``repo``'s work and record how it ended."""
        try:
            work()
        except RepoBudgetExceeded as exc:
            reason = self.tick.meter(repo).stopped or str(exc)
            self.shortfall(repo, f"{step} cut short: {reason}", full_tick_due=full_tick_due)
            return "cut"
        except RateLimitStop:
            self.error(repo, f"{step} stopped: {RATE_LIMITED}")
            return "rate limit"
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                self.rate_limited(repo, step, exc)
                return "rate limit"
            logger.exception("%s: %s failed", repo, step)
            self.errors.append(f"{repo}: {step} failed: {exc}")
            return "failed"
        return "done"

    def result(self, repo: str, step: str, work: Callable[[], _T]) -> _T | None:
        """``work``'s result through ``attempt``; None, recorded there, when it did not finish."""
        found: list[_T] = []
        self.attempt(repo, step, lambda: found.append(work()))
        return found[0] if found else None
