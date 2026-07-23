"""Single-instance and per-iteration timeout guards for radar."""

from __future__ import annotations

import fcntl
import logging
import os
import signal
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

logger = logging.getLogger(__name__)


class SingleInstanceError(RuntimeError): ...


class IterationTimeout(TimeoutError): ...


@contextmanager
def single_instance_lock(path: str | None) -> Iterator[None]:
    if not path:
        yield
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
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
        logger.debug("iteration timeout disabled off the main thread")
        yield
        return

    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
