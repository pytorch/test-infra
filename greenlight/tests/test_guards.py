import errno
import fcntl
import logging
import signal
import threading
import time

import pytest

from greenlight import guards
from greenlight.guards import (
    IterationTimeout,
    LockError,
    SingleInstanceError,
    hard_deadline,
    iteration_timeout,
    single_instance_lock,
)


def test_exception_hierarchy():
    assert issubclass(SingleInstanceError, RuntimeError)
    assert issubclass(IterationTimeout, TimeoutError)


@pytest.mark.parametrize("path", [None, ""])
def test_lock_missing_path_is_noop_and_warns(path, caplog):
    ran = False
    with caplog.at_level(logging.WARNING, logger="greenlight"), single_instance_lock(path):
        ran = True
    assert ran
    assert "PYTORCH_GREENLIGHT_LOCK_PATH" in caplog.text


def test_lock_same_path_twice_raises(tmp_lock_path):
    with single_instance_lock(tmp_lock_path), pytest.raises(SingleInstanceError), single_instance_lock(tmp_lock_path):
        pass  # pragma: no cover - inner body must not run


def test_lock_released_then_reacquired(tmp_lock_path):
    with single_instance_lock(tmp_lock_path):
        pass
    with single_instance_lock(tmp_lock_path):
        pass


def test_lock_open_failure_raises_lock_error_naming_path(tmp_path):
    missing = str(tmp_path / "nope" / "greenlight.lock")
    with pytest.raises(LockError) as excinfo, single_instance_lock(missing):
        pass  # pragma: no cover - lock acquisition fails first
    assert missing in str(excinfo.value)
    assert not isinstance(excinfo.value, SingleInstanceError)


def test_lock_flock_oserror_propagates(tmp_lock_path, monkeypatch):
    def boom(fd, operation):
        raise OSError(errno.ENOLCK, "no locks available")

    monkeypatch.setattr(fcntl, "flock", boom)
    with pytest.raises(OSError) as excinfo, single_instance_lock(tmp_lock_path):
        pass  # pragma: no cover - lock acquisition fails first
    assert not isinstance(excinfo.value, SingleInstanceError)


def test_iteration_timeout_zero_is_noop():
    before = signal.getsignal(signal.SIGALRM)
    ran = False
    with iteration_timeout(0):
        ran = True
    assert ran
    assert signal.getsignal(signal.SIGALRM) is before


def test_iteration_timeout_negative_is_noop():
    before = signal.getsignal(signal.SIGALRM)
    ran = False
    with iteration_timeout(-1.0):
        ran = True
    assert ran
    assert signal.getsignal(signal.SIGALRM) is before


def test_iteration_timeout_success_restores_handler():
    before = signal.getsignal(signal.SIGALRM)
    with iteration_timeout(5.0):
        pass  # completes well within the timeout window
    assert signal.getsignal(signal.SIGALRM) is before


def test_iteration_timeout_fires_and_restores_handler():
    before = signal.getsignal(signal.SIGALRM)
    with pytest.raises(IterationTimeout), iteration_timeout(0.05):
        time.sleep(0.5)
    # The previous SIGALRM handler must be restored after the context exits.
    assert signal.getsignal(signal.SIGALRM) is before


def test_iteration_timeout_off_main_thread_runs_without_timeout():
    ran: list[bool] = []
    errors: list[Exception] = []

    def worker() -> None:
        try:
            with iteration_timeout(0.1):
                ran.append(True)
        except ValueError as exc:
            errors.append(exc)

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()

    assert ran == [True]
    assert errors == []


@pytest.mark.parametrize("error", [OverflowError("too large"), signal.ItimerError("bad timer")])
def test_iteration_timeout_arm_failure_runs_without_timer(error, monkeypatch, caplog):
    before = signal.getsignal(signal.SIGALRM)

    def boom(which, seconds):
        raise error

    monkeypatch.setattr(signal, "setitimer", boom)
    ran = False
    with caplog.at_level(logging.WARNING, logger="greenlight"), iteration_timeout(5.0):
        ran = True
    assert ran
    assert signal.getsignal(signal.SIGALRM) is before
    assert any(record.levelno == logging.WARNING for record in caplog.records)


def test_hard_watchdog_fires_once_when_deadline_passed():
    calls: list[int] = []
    now = {"t": 100.0}
    wd = guards._HardWatchdog(monotonic=lambda: now["t"], on_expire=lambda: calls.append(1))
    wd.register(105.0)
    now["t"] = 106.0
    assert wd.poll() is True
    assert wd.poll() is False
    assert calls == [1]


def test_hard_watchdog_does_not_fire_before_deadline():
    calls: list[int] = []
    wd = guards._HardWatchdog(monotonic=lambda: 100.0, on_expire=lambda: calls.append(1))
    wd.register(200.0)
    assert wd.poll() is False
    assert calls == []


def test_hard_watchdog_cleared_deadline_does_not_fire():
    calls: list[int] = []
    now = {"t": 100.0}
    wd = guards._HardWatchdog(monotonic=lambda: now["t"], on_expire=lambda: calls.append(1))
    wd.register(105.0)
    wd.clear()
    now["t"] = 999.0
    assert wd.poll() is False
    assert calls == []


def test_hard_watchdog_thread_fires_when_breached():
    fired = threading.Event()
    now = {"t": 100.0}
    wd = guards._HardWatchdog(monotonic=lambda: now["t"], on_expire=fired.set, poll_seconds=0.01)
    wd.start()
    now["t"] = 999.0
    wd.register(200.0)
    assert fired.wait(2.0)


def test_hard_watchdog_start_is_idempotent():
    wd = guards._HardWatchdog(on_expire=lambda: None, poll_seconds=0.05)
    wd.start()
    first = wd._thread
    assert first is not None
    assert first.is_alive()
    wd.start()
    assert wd._thread is first
    wd.register(-1.0)  # breach against the real clock so the daemon exits cleanly
    first.join(2.0)
    assert not first.is_alive()


def test_hard_watchdog_start_replaces_dead_thread():
    wd = guards._HardWatchdog(on_expire=lambda: None, poll_seconds=0.05)
    dead = threading.Thread(target=lambda: None)
    dead.start()
    dead.join()
    wd._thread = dead
    wd.start()
    replacement = wd._thread
    assert replacement is not None
    assert replacement is not dead
    assert replacement.is_alive()
    wd.register(-1.0)  # breach so the fresh daemon exits cleanly
    replacement.join(2.0)


def test_hard_deadline_arms_and_clears_watchdog(recording_watchdog):
    with hard_deadline(5.0, grace=30.0, monotonic=lambda: 1000.0, watchdog=recording_watchdog):
        pass
    assert recording_watchdog.started == 1
    assert recording_watchdog.registered == [1035.0]
    assert recording_watchdog.cleared == 1


def test_hard_deadline_clears_even_on_exception(recording_watchdog):
    with pytest.raises(ValueError), hard_deadline(5.0, monotonic=lambda: 0.0, watchdog=recording_watchdog):
        raise ValueError("boom")
    assert recording_watchdog.cleared == 1


@pytest.mark.parametrize("seconds", [0.0, -1.0])
def test_hard_deadline_non_positive_arms_nothing(seconds, recording_watchdog):
    ran = False
    with hard_deadline(seconds, watchdog=recording_watchdog):
        ran = True
    assert ran
    assert recording_watchdog.started == 0
    assert recording_watchdog.registered == []
    assert recording_watchdog.cleared == 0
