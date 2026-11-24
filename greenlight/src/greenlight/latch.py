"""The rate-limit latch of one scan invocation, and how it follows the state store's shared latch.

``RateLimitLatch`` is a ``threading.Event`` that keeps until when the rate limits that set it asked to wait
(``rate_limit_until``: ``x-ratelimit-reset`` at ``x-ratelimit-remaining: 0``, else ``Retry-After``, else
``RATE_LIMIT_DEFAULT_WAIT``, never past ``RATE_LIMIT_LATCH_MAX``). Work that catches a rate limit itself
sets it through ``latch_rate_limit``, so the wait the response asked for is kept; a plain ``set`` waits
the default.

With a ``SharedLatch`` (the scan Lambda's), the latch publishes each later wait to the store the moment
it is set, so the other invocations see it at once, and reads the store's latch again when asked
(``recheck``, before each optional phase and before a dispatch) and once ``QUOTA_REFRESH_REQUESTS`` of the
invocation's requests were counted since the last read (``poll``). A shared latch that holds sets this
one. A store failure on either is logged, and the invocation goes on with its own latch.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight.constants import QUOTA_REFRESH_REQUESTS, RATE_LIMIT_DEFAULT_WAIT, RATE_LIMIT_LATCH_MAX
from greenlight.state_store import StoreError, epoch_text

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from greenlight.state_store import StateStore

logger = logging.getLogger(__name__)


def seconds(raw: object) -> float | None:
    """``raw`` as a number of seconds, None when it is none."""
    try:
        return float(str(raw))
    except ValueError:
        return None


def rate_limit_until(headers: Mapping[str, str] | None, now: float) -> float:
    """Until when a rate-limit response asks to wait: ``x-ratelimit-reset`` when ``x-ratelimit-remaining`` is
    0, else ``Retry-After`` seconds, else ``RATE_LIMIT_DEFAULT_WAIT``; never past ``RATE_LIMIT_LATCH_MAX``."""
    found = {str(name).lower(): value for name, value in (headers or {}).items()}
    reset = seconds(found.get("x-ratelimit-reset")) if found.get("x-ratelimit-remaining") == "0" else None
    retry_after = seconds(found.get("retry-after"))
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


@dataclass(frozen=True)
class SharedLatch:
    """The state store's latch, shared by every invocation of the installation; its failures are logged."""

    store: StateStore
    clock: Callable[[], float]

    def read(self) -> float | None:
        try:
            return self.store.read_latch(self.clock())
        except StoreError:
            logger.error("cannot read the shared rate-limit latch; this invocation goes on with its own", exc_info=True)
            return None

    def publish(self, until: float) -> None:
        try:
            self.store.extend_latch(until, self.clock())
        except StoreError:
            logger.error(
                "cannot record the shared rate-limit latch now; this invocation records it again when it ends",
                exc_info=True,
            )


class RateLimitLatch(threading.Event):
    """One invocation's rate-limit latch: set once a rate limit is met, and until when it asked to wait.

    ``count`` gives the invocation's request count, which ``poll`` paces its reads of ``shared`` by.
    """

    def __init__(
        self,
        clock: Callable[[], float] = time.time,
        shared: SharedLatch | None = None,
        count: Callable[[], int] = lambda: 0,
    ) -> None:
        super().__init__()
        self._clock = clock
        self._shared = shared
        self._count = count
        self._lock = threading.Lock()
        self._until: float | None = None
        self._read_at = 0

    @property
    def until(self) -> float | None:
        """Until when the rate limits that set the latch asked to wait, the latest; None while it is not set."""
        with self._lock:
            return self._until

    def set(self) -> None:
        """Set the latch for a rate limit whose wait is unknown: ``RATE_LIMIT_DEFAULT_WAIT``."""
        self.note(None)

    def note(self, headers: Mapping[str, str] | None) -> None:
        """Set the latch for a rate-limit response with ``headers``."""
        self.hold(rate_limit_until(headers, self._clock()))

    def hold(self, until: float, *, publish: bool = True) -> None:
        """Set the latch until ``until`` unless it already holds later, publishing a later wait when asked."""
        with self._lock:
            later = self._until is None or until > self._until
            if later:
                self._until = until
        super().set()
        if later and publish and self._shared is not None:
            self._shared.publish(until)

    def recheck(self) -> None:
        """Read the shared latch now, unless this one is set; a shared latch that holds sets this one."""
        self._read(due=lambda _count: True)

    def poll(self) -> None:
        """``recheck`` once ``QUOTA_REFRESH_REQUESTS`` of the invocation's requests were counted since the last read."""
        self._read(due=lambda count: count - self._read_at >= QUOTA_REFRESH_REQUESTS)

    def _read(self, *, due: Callable[[int], bool]) -> None:
        if self._shared is None or self.is_set():
            return
        with self._lock:
            count = self._count()
            if not due(count):
                return
            self._read_at = count
        until = self._shared.read()
        if until is not None:
            logger.warning(
                "the shared rate-limit latch holds until %s; this invocation stops its GitHub work", epoch_text(until)
            )
            self.hold(until, publish=False)


def latch_rate_limit(cancel_event: threading.Event, exc: BaseException) -> None:
    """Set ``cancel_event`` for the rate limit ``exc``: a ``RateLimitLatch`` keeps the wait its response asked for."""
    if isinstance(cancel_event, RateLimitLatch):
        cancel_event.note(rate_limit_headers(exc))
    else:
        cancel_event.set()


def recheck(cancel_event: threading.Event) -> None:
    """Read the shared latch now when ``cancel_event`` is an invocation's ``RateLimitLatch``."""
    if isinstance(cancel_event, RateLimitLatch):
        cancel_event.recheck()
