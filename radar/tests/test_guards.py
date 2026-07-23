import errno
import fcntl
import signal
import threading
import time

import pytest

from radar.guards import (
    IterationTimeout,
    SingleInstanceError,
    iteration_timeout,
    single_instance_lock,
)


def test_exception_hierarchy():
    assert issubclass(SingleInstanceError, RuntimeError)
    assert issubclass(IterationTimeout, TimeoutError)


def test_lock_none_is_noop():
    ran = False
    with single_instance_lock(None):
        ran = True
    assert ran


def test_lock_empty_string_is_noop():
    ran = False
    with single_instance_lock(""):
        ran = True
    assert ran


def test_lock_same_path_twice_raises(tmp_lock_path):
    with single_instance_lock(tmp_lock_path), pytest.raises(SingleInstanceError), single_instance_lock(tmp_lock_path):
        pass  # pragma: no cover - inner body must not run


def test_lock_released_then_reacquired(tmp_lock_path):
    with single_instance_lock(tmp_lock_path):
        pass
    with single_instance_lock(tmp_lock_path):
        pass


def test_lock_nonexistent_directory_propagates_oserror(tmp_path):
    missing = str(tmp_path / "nope" / "radar.lock")
    with pytest.raises(OSError) as excinfo, single_instance_lock(missing):
        pass  # pragma: no cover - lock acquisition fails first
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
