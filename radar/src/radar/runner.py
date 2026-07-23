"""Resilient daemon loop around the radar unit of work."""

from __future__ import annotations

import logging
import signal
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from radar.guards import iteration_timeout

if TYPE_CHECKING:
    from radar.config import Config

logger = logging.getLogger(__name__)

_MAX_BACKOFF_EXPONENT = 32

WaitFn = Callable[[threading.Event, float], bool]


def _default_wait(stop: threading.Event, timeout: float) -> bool:
    return stop.wait(timeout)


def _install_stop_signals(stop: threading.Event) -> None:
    def _handler(*_args: object) -> None:
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except ValueError:
            logger.warning("cannot install handler for signal %s off the main thread", sig)


def execute_once(config: Config, run: Callable[[Config], None]) -> None:
    with iteration_timeout(config.max_runtime_seconds):
        run(config)


def run_forever(
    config: Config,
    *,
    run: Callable[[Config], None],
    stop_event: threading.Event | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    wait: WaitFn | None = None,
    install_signal_handlers: bool = True,
) -> None:
    stop = stop_event if stop_event is not None else threading.Event()
    wait_fn = wait or _default_wait
    if install_signal_handlers:
        _install_stop_signals(stop)
    failures = 0
    logger.info("daemon starting with interval %s seconds", config.interval_seconds)
    while not stop.is_set():
        start = monotonic()
        try:
            with iteration_timeout(config.max_runtime_seconds):
                run(config)
            failures = 0
            delay = max(0.0, config.interval_seconds - (monotonic() - start))
        except Exception:
            logger.exception("iteration failed")
            delay = min(
                config.backoff_max_seconds,
                config.backoff_base_seconds * (2 ** min(failures, _MAX_BACKOFF_EXPONENT)),
            )
            failures += 1
        if wait_fn(stop, delay):
            break
    logger.info("daemon stopped")
