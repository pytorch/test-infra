import random
import time
from enum import Enum


class RestartAction(Enum):
    """Controls restart behavior.

    - SKIP: no logging, no side effects
    - LOG: read prod state, log intended actions (no side effects)
    - RUN: read prod state, dispatch restarts (side effects)
    """

    SKIP = "skip"
    LOG = "log"
    RUN = "run"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.value

    @property
    def side_effects(self) -> bool:
        """True if this mode performs external side effects (GitHub dispatch)."""
        return self is RestartAction.RUN


class RevertAction(Enum):
    """Controls revert behavior.

    - SKIP: no logging, no side effects
    - LOG: read prod state, log revert intent only (no side effects)
    - RUN_LOG: read prod state, log revert intent with production dry-run flag (side effects limited to logging)
    - RUN_NOTIFY: read prod state, send notification (side effect) but no revert
    - RUN_REVERT: read prod state, perform revert (side effect)
    """

    SKIP = "skip"
    LOG = "log"
    RUN_LOG = "run-log"
    RUN_NOTIFY = "run-notify"
    RUN_REVERT = "run-revert"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.value

    @property
    def side_effects(self) -> bool:
        """True if this mode performs external side effects or non-dry-run logging."""
        return self in (
            RevertAction.RUN_LOG,
            RevertAction.RUN_NOTIFY,
            RevertAction.RUN_REVERT,
        )


class _TryAgain(Exception):
    pass


class _Attempt:
    def __init__(self, ctrl):
        self._c = ctrl

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        # Success: stop the outer iterator
        if exc_type is None:
            self._c._done = True
            return False  # don't suppress; just signal done to iterator

        # Failure: if out of retries, let the original exception bubble
        if self._c._attempt >= self._c.max_retries:
            return False

        # Backoff before asking the iterator for another attempt
        delay = self._c.base_delay * (2 ** (self._c._attempt - 1))
        if self._c.jitter:
            delay += random.uniform(0, 0.1 * delay)
        time.sleep(delay)

        # Swallow the original exception so the iterator can decide to retry
        return True


class RetryWithBackoff:
    """
    Usage:
        for attempt in RetryWithBackoff(max_retries=4, base_delay=1, jitter=True):
            with attempt:
                # your code that might raise
    """

    def __init__(self, max_retries=5, base_delay=0.5, jitter=True):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.jitter = jitter

    def __iter__(self):
        self._attempt = 1
        self._done = False
        while True:
            # Yield a context manager for the attempt; if the with-block
            # raised but is retryable, __exit__ returns True to suppress it.
            yield _Attempt(self)
            # If the with-block succeeded, stop iterating.
            if self._done:
                return
            # Otherwise, a retryable exception occurred and was suppressed.
            # Move to the next attempt.
            self._attempt += 1
