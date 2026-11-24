"""Per-invocation GitHub request metering: request counts, Phase B stops and the rate-limit latch.

One ``TickMeter`` per scan invocation holds the latch, until when the rate limit that set it asked to
wait (``rate_limit_until``; the invocation records it in the state store's shared latch), and the
invocation's request total, and makes one ``RequestMeter`` per repo, shared by every GitHub client that
repo's work builds. A meter sits at the two seams
PyGithub and urllib3 offer. ``CountingToken.authentication`` runs once per request, before it is sent:
it raises ``RateLimitStop`` once the latch is set and ``RepoBudgetExceeded`` once the meter's ``stop``
gives a reason, and otherwise counts the request. ``MeteredRetry.increment`` runs once per retry
attempt, before its sleep: on a rate-limit response it sets the latch, and on a set latch or a stop it
ends the retrying; otherwise it counts the attempt urllib3 will make. It never raises an
``IterationTimeout``, since requests turns any ``OSError`` raised inside urllib3 into a
``ConnectionError``: the next request's ``authentication`` raises the typed signal instead. urllib3
calls it on a response only when the ``Retry`` would retry that status, so a 429 off the fail-fast
client's forcelist, and any 403, reach the caller as a ``GithubException`` for its own rate-limit check.
PyGithub's 301, 302 and 202 follow-ups pass neither seam and are not counted.

``QuotaGauge`` estimates the installation's remaining requests between reads of ``GET /rate_limit``
(``core_quota``; none once the latch is set, and a rate-limited read sets it). The quota is shared by every
invocation of the installation, so the gauge reads it again every ``QUOTA_REFRESH_REQUESTS`` of its own
requests as well as when asked, and its estimate follows what the others spent. ``phase_b_stop`` builds
the stop a repo's optional work runs under.
"""

from __future__ import annotations

import inspect
import logging
import threading
import time
from typing import TYPE_CHECKING, Any, Literal, Self

from github import Auth
from urllib3.exceptions import MaxRetryError, ResponseError
from urllib3.util.retry import Retry

from greenlight.constants import QUOTA_REFRESH_REQUESTS, RATE_LIMIT_DEFAULT_WAIT, RATE_LIMIT_LATCH_MAX
from greenlight.github_client import is_rate_limit_error, is_rate_limit_status
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from types import TracebackType

    from github import Github
    from urllib3.connectionpool import ConnectionPool
    from urllib3.response import BaseHTTPResponse

logger = logging.getLogger(__name__)

Phase = Literal["A", "B"]

RATE_LIMIT = "rate limit"
_RETRY_PARAMETERS: tuple[str, ...] = tuple(
    name for name in inspect.signature(Retry.__init__).parameters if name != "self"
)


def _seconds(raw: object) -> float | None:
    try:
        return float(str(raw))
    except ValueError:
        return None


def rate_limit_until(headers: Mapping[str, str] | None, now: float) -> float:
    """Until when a rate-limit response asks to wait: ``x-ratelimit-reset`` when ``x-ratelimit-remaining`` is
    0, else ``Retry-After`` seconds, else ``RATE_LIMIT_DEFAULT_WAIT``; never past ``RATE_LIMIT_LATCH_MAX``."""
    found = {str(name).lower(): value for name, value in (headers or {}).items()}
    reset = _seconds(found.get("x-ratelimit-reset")) if found.get("x-ratelimit-remaining") == "0" else None
    retry_after = _seconds(found.get("retry-after"))
    if reset is not None:
        until = reset
    elif retry_after is not None:
        until = now + retry_after
    else:
        until = now + RATE_LIMIT_DEFAULT_WAIT.total_seconds()
    return min(until, now + RATE_LIMIT_LATCH_MAX.total_seconds())


def rate_limit_headers(exc: BaseException) -> Mapping[str, str] | None:
    """The response headers a rate-limit failure carries, when it carries any."""
    headers = getattr(exc, "headers", None)
    return headers if isinstance(headers, dict) else None


class RepoBudgetExceeded(IterationTimeout):
    """A repo's ``stop`` gave a reason: its optional work ends for this tick."""


class RateLimitStop(IterationTimeout):
    """The tick's rate-limit latch is set: no further GitHub request starts this tick."""


class TickMeter:
    """One invocation's rate-limit latch and until when it asked to wait, its request total and its repo meters."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.latch = threading.Event()
        self._clock = clock
        self._lock = threading.Lock()
        self._total = 0
        self._until: float | None = None
        self._meters: dict[str, RequestMeter] = {}

    @property
    def total(self) -> int:
        with self._lock:
            return self._total

    @property
    def latch_until(self) -> float | None:
        """Until when the rate limits that set the latch asked to wait, the latest; None while it is not set.

        Work that catches a rate limit itself sets the latch (its ``cancel_event``) without the response's
        headers: such a latch waits ``RATE_LIMIT_DEFAULT_WAIT`` from the first time this is asked.
        """
        with self._lock:
            if self._until is None and self.latch.is_set():
                self._until = rate_limit_until(None, self._clock())
            return self._until

    def note_rate_limit(self, headers: Mapping[str, str] | None) -> None:
        """Set the latch for a rate-limit response with ``headers``, keeping the latest wait it asks for."""
        until = rate_limit_until(headers, self._clock())
        with self._lock:
            self._until = until if self._until is None else max(self._until, until)
        self.latch.set()

    def meter(self, repo: str) -> RequestMeter:
        """``repo``'s meter for this tick, made on first use."""
        with self._lock:
            found = self._meters.get(repo)
            if found is None:
                found = self._meters[repo] = RequestMeter(self, repo)
            return found

    def add_request(self) -> None:
        with self._lock:
            self._total += 1


class RequestMeter:
    """One repo's requests in one tick, per phase, and what stops its work.

    ``phase`` and ``stop`` are set by the tick; ``stopped`` says why the meter last stopped work.
    """

    def __init__(self, tick: TickMeter, repo: str) -> None:
        self.repo = repo
        self.phase: Phase = "A"
        self.stop: Callable[[], str | None] | None = None
        self.stopped: str | None = None
        self._tick = tick
        self._lock = threading.Lock()
        self._counts: dict[Phase, int] = {"A": 0, "B": 0}

    @property
    def latch(self) -> threading.Event:
        return self._tick.latch

    def requests(self, phase: Phase) -> int:
        with self._lock:
            return self._counts[phase]

    def count(self) -> None:
        with self._lock:
            self._counts[self.phase] += 1
        self._tick.add_request()

    def stop_reason(self) -> str | None:
        """Why this repo's work must stop now, recorded in ``stopped``: a set latch, else ``stop``'s reason."""
        if self.latch.is_set():
            reason: str | None = RATE_LIMIT
        else:
            reason = None if self.stop is None else self.stop()
        if reason is not None:
            self.stopped = reason
        return reason

    def rate_limited(self, headers: Mapping[str, str] | None) -> None:
        self.stopped = RATE_LIMIT
        self._tick.note_rate_limit(headers)

    def before_request(self) -> None:
        reason = self.stop_reason()
        if reason is None:
            return
        if self.latch.is_set():
            raise RateLimitStop(f"{self.repo}: a rate limit stopped this tick's GitHub work")
        raise RepoBudgetExceeded(f"{self.repo}: {reason}")

    def auth(self, token: str) -> CountingToken:
        return CountingToken(token, self)

    def retry(self, base: Retry) -> MeteredRetry:
        """``base`` with every one of its parameters, metered."""
        return MeteredRetry(meter=self, **{name: getattr(base, name) for name in _RETRY_PARAMETERS})


class CountingToken(Auth.Token):
    """A token auth that refuses or counts each request PyGithub sends, before it is sent."""

    def __init__(self, token: str, meter: RequestMeter) -> None:
        super().__init__(token)
        self.meter = meter

    def authentication(self, headers: dict[Any, Any]) -> None:
        self.meter.before_request()
        self.meter.count()
        super().authentication(headers)


class MeteredRetry(Retry):
    """A urllib3 ``Retry`` that counts each retry attempt and ends retrying on a rate limit or a stop."""

    def __init__(self, *, meter: RequestMeter, **params: Any) -> None:
        super().__init__(**params)
        self.meter = meter

    def new(self, **kw: Any) -> Self:
        return super().new(meter=self.meter, **kw)

    def increment(
        self,
        method: str | None = None,
        url: str | None = None,
        response: BaseHTTPResponse | None = None,
        error: Exception | None = None,
        _pool: ConnectionPool | None = None,
        _stacktrace: TracebackType | None = None,
    ) -> Self:
        if response is not None and is_rate_limit_status(response.status, response.headers):
            self.meter.rate_limited(response.headers)
            logger.warning(
                "%s: GitHub answered %d, a rate limit; the invocation stops its GitHub work",
                self.meter.repo,
                response.status,
            )
            reason = ResponseError(ResponseError.SPECIFIC_ERROR.format(status_code=response.status))
            raise MaxRetryError(_pool, url, reason)  # type: ignore[arg-type]
        stop = self.meter.stop_reason()
        if stop is not None:
            logger.warning("%s: no retry of %s %s: %s", self.meter.repo, method, url, stop)
            raise MaxRetryError(_pool, url, ResponseError(f"greenlight stopped retrying: {stop}"))  # type: ignore[arg-type]
        retry = super().increment(method, url, response, error, _pool, _stacktrace)
        self.meter.count()
        return retry


def core_quota(client: Github) -> tuple[int, int]:
    """The installation's core ``(remaining, limit)``, from ``GET /rate_limit`` (which costs no quota)."""
    core = client.get_rate_limit().resources.core
    return core.remaining, core.limit


class QuotaGauge:
    """The installation's core quota, estimated between reads by subtracting what the invocation counted since.

    ``read`` returns the core ``(remaining, limit)`` (``GET /rate_limit``, which costs no quota); None
    reads nothing, and the estimate stays unknown. ``remaining`` reads again once ``refresh_every`` of the
    invocation's requests were counted since the last read or attempt.
    """

    def __init__(
        self,
        tick: TickMeter,
        read: Callable[[], tuple[int, int]] | None,
        *,
        refresh_every: int = QUOTA_REFRESH_REQUESTS,
    ) -> None:
        self._tick = tick
        self._read = read
        self._refresh_every = refresh_every
        self._lock = threading.Lock()
        self._reading: tuple[int, int, int] | None = None
        self._attempted_at: int | None = None

    def refresh(self) -> None:
        """Read the quota now, unless the latch is set or another thread is reading it.

        A rate-limited read sets the latch; any other failed read is logged and the last reading kept.
        """
        if self._read is None or self._tick.latch.is_set() or not self._lock.acquire(blocking=False):
            return
        try:
            self._attempted_at = self._tick.total
            remaining, limit = self._read()
        except IterationTimeout:
            raise
        except Exception as exc:
            if is_rate_limit_error(exc):
                logger.warning(
                    "reading the installation's rate limit hit a rate limit; the invocation stops its GitHub work",
                    exc_info=True,
                )
                self._tick.note_rate_limit(rate_limit_headers(exc))
            else:
                logger.warning("cannot read the installation's rate limit; keeping the last reading", exc_info=True)
        else:
            self._reading = (remaining, limit, self._tick.total)
        finally:
            self._lock.release()

    def remaining(self) -> int | None:
        attempted_at = self._attempted_at
        if attempted_at is not None and self._tick.total - attempted_at >= self._refresh_every:
            self.refresh()
        reading = self._reading
        if reading is None:
            return None
        remaining, _limit, counted_at = reading
        return remaining - (self._tick.total - counted_at)

    @property
    def limit(self) -> int | None:
        reading = self._reading
        return None if reading is None else reading[1]


def phase_b_stop(
    meter: RequestMeter,
    *,
    gauge: QuotaGauge,
    floor: int,
    deadline: float | None,
    request_budget: int | None,
    monotonic: Callable[[], float] = time.monotonic,
) -> Callable[[], str | None]:
    """The stop of ``meter``'s Phase B: past ``deadline``, its Phase B ``request_budget`` spent, or the
    installation's estimated remaining requests below ``floor`` (an unknown estimate never stops it)."""

    def stop() -> str | None:
        if deadline is not None and monotonic() >= deadline:
            return "past its deadline"
        if request_budget is not None and meter.requests("B") >= request_budget:
            return f"its request budget of {request_budget} is spent"
        remaining = gauge.remaining()
        if remaining is not None and remaining < floor:
            return f"the installation has {remaining} requests left, below the floor of {floor}"
        return None

    return stop
