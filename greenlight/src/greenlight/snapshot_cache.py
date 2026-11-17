"""A lazy, TTL-bounded snapshot of something read from GitHub, with a per-failure stale policy.

The repos config and each repo's eligibility source (its merge rules) are read through one of
these. A snapshot is fetched on first use and again once ``ttl_seconds`` have passed, measured on
the wall clock: a monotonic clock may not advance while Lambda freezes the execution environment
between invocations. Each fetch builds its own client from the builder passed to ``snapshot`` (tokens
change between ticks) and closes it as soon as the fetch returns.

A failed refresh is judged by its class:

- a rate limit is re-raised, never served stale: the scan must stop on a throttled token;
- ``IterationTimeout`` is re-raised: it is the scan's control signal, not a refresh failure;
- a transient failure (a GitHub 5xx, a connection, timeout or retry error that is not a rate limit,
  any other ``OSError``) serves the last good snapshot while it is younger than
  ``max_stale_seconds`` (None: no bound);
- anything else (a parse or shape error, a 404, a 403 that is not a rate limit) means the source is
  broken or missing: the last good snapshot is served only when ``stale_on_broken``.

With nothing to serve, the failure propagates. Not thread-safe: it is read from the main thread, and
the immutable snapshot is what fans out.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from greenlight import github_client
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)


def is_transient(exc: BaseException) -> bool:
    """A failure a retry may clear: a GitHub 5xx, a connection, timeout or retry error, any other ``OSError``.

    Rate limits are judged before this is asked. requests' exceptions are all ``OSError``s.
    """
    from github import GithubException
    from urllib3.exceptions import HTTPError as Urllib3Error

    if isinstance(exc, GithubException):
        status = getattr(exc, "status", None)
        return isinstance(status, int) and 500 <= status < 600
    return isinstance(exc, OSError | Urllib3Error)


class SnapshotCache[C, T]:
    """One cached ``fetch(client)`` result; ``snapshot(build_client)`` returns it, refreshing when due.

    ``stale_error`` is the failure behind the snapshot the last ``snapshot`` call served stale, or None
    when that call served a fresh one.
    """

    def __init__(
        self,
        fetch: Callable[[C], T],
        *,
        ttl_seconds: float,
        max_stale_seconds: float | None,
        stale_on_broken: bool,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._fetch = fetch
        self._ttl_seconds = ttl_seconds
        self._max_stale_seconds = max_stale_seconds
        self._stale_on_broken = stale_on_broken
        self._clock = clock
        self._cached: tuple[T, float] | None = None
        self.stale_error: BaseException | None = None

    def snapshot(self, build_client: Callable[[], C]) -> T:
        cached = self._cached
        if cached is not None and 0 <= self._clock() - cached[1] < self._ttl_seconds:
            self.stale_error = None
            return cached[0]
        client = build_client()
        try:
            result = self._fetch(client)
        except IterationTimeout:
            raise
        except Exception as exc:
            if cached is None or github_client.is_rate_limit_error(exc):
                raise
            return self._serve_stale(exc, cached)
        finally:
            github_client.close_client(client)
        self._cached = (result, self._clock())
        self.stale_error = None
        return result

    def _serve_stale(self, exc: Exception, cached: tuple[T, float]) -> T:
        age = self._clock() - cached[1]
        if is_transient(exc):
            kind = "transient"
            allowed = self._max_stale_seconds is None or 0 <= age < self._max_stale_seconds
        else:
            kind = "broken source"
            allowed = self._stale_on_broken
        if not allowed:
            raise exc
        logger.warning(
            "refresh of %s failed (%s); serving the snapshot fetched %.0fs ago",
            getattr(self._fetch, "__name__", "snapshot"),
            kind,
            age,
            exc_info=True,
        )
        self.stale_error = exc
        return cached[0]
