"""Single-instance, per-iteration timeout, and hard-deadline guards for greenlight."""

from __future__ import annotations

import fcntl
import logging
import os
import signal
import threading
import time
from contextlib import contextmanager
from typing import TYPE_CHECKING, Protocol

from greenlight.exit_codes import EXIT_FAILURE

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

logger = logging.getLogger(__name__)

_WATCHDOG_GRACE_SECONDS = 30.0
_WATCHDOG_POLL_SECONDS = 1.0


class SingleInstanceError(RuntimeError): ...


class IterationTimeout(TimeoutError): ...


class LockError(OSError): ...


@contextmanager
def single_instance_lock(path: str | None) -> Iterator[None]:
    if not path:
        logger.warning("running without a single-instance lock (set PYTORCH_GREENLIGHT_LOCK_PATH to enable)")
        yield
        return
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
    except OSError as exc:
        raise LockError(f"cannot open lock file at {path}: {exc}") from exc
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(fd)
        raise SingleInstanceError(f"another instance holds the lock at {path}") from exc
    except OSError:
        os.close(fd)
        raise
    try:
        yield
    finally:
        os.close(fd)


@contextmanager
def iteration_timeout(seconds: float) -> Iterator[None]:
    if seconds <= 0:
        yield
        return

    def _on_alarm(*_args: object) -> None:
        raise IterationTimeout(f"iteration exceeded {seconds} seconds")

    try:
        previous = signal.signal(signal.SIGALRM, _on_alarm)
    except ValueError:
        # SIGALRM only installs on the main thread; the hard watchdog covers off-thread hangs.
        logger.debug("iteration timeout disabled off the main thread")
        yield
        return

    armed = False
    try:
        try:
            signal.setitimer(signal.ITIMER_REAL, seconds)
            armed = True
        except (OverflowError, signal.ItimerError):
            logger.warning("cannot arm iteration timeout for %s seconds; running without it", seconds)
        yield
    finally:
        if armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class _Watchdog(Protocol):
    def start(self) -> None: ...
    def register(self, deadline_monotonic: float) -> None: ...
    def clear(self) -> None: ...


class _HardWatchdog:
    """Source-agnostic backstop that force-exits an iteration that never returns.

    SIGALRM cannot interrupt off-main-thread work or blocking C calls (DNS); one shared
    daemon thread polls a registered deadline and, once past it, runs the exit action.
    The clock and exit action are injectable so tests can breach a deadline without
    terminating the process.
    """

    def __init__(
        self,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        on_expire: Callable[[], None] | None = None,
        poll_seconds: float = _WATCHDOG_POLL_SECONDS,
    ) -> None:
        self._monotonic = monotonic
        self._on_expire = on_expire if on_expire is not None else lambda: os._exit(EXIT_FAILURE)
        self._poll_seconds = poll_seconds
        self._deadline: float | None = None
        self._fired = False
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, name="greenlight-watchdog", daemon=True)
            self._thread.start()

    def register(self, deadline_monotonic: float) -> None:
        with self._lock:
            self._deadline = deadline_monotonic
            self._fired = False
        self._wake.set()

    def clear(self) -> None:
        with self._lock:
            self._deadline = None
        self._wake.set()

    def poll(self) -> bool:
        with self._lock:
            deadline = self._deadline
            if deadline is None or self._fired or self._monotonic() <= deadline:
                return False
            self._fired = True
            self._deadline = None
        logger.critical("hard watchdog deadline exceeded; forcing exit")
        self._on_expire()
        return True

    def _run(self) -> None:
        while True:
            self._wake.wait(self._poll_seconds)
            self._wake.clear()
            if self.poll():
                return


_WATCHDOG = _HardWatchdog()


@contextmanager
def hard_deadline(
    seconds: float,
    *,
    grace: float = _WATCHDOG_GRACE_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
    watchdog: _Watchdog | None = None,
) -> Iterator[None]:
    if seconds <= 0:
        yield
        return
    wd = watchdog if watchdog is not None else _WATCHDOG
    wd.start()
    wd.register(monotonic() + seconds + grace)
    try:
        yield
    finally:
        wd.clear()
