import logging
import signal
import threading
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from radar import runner

if TYPE_CHECKING:
    from collections.abc import Callable


class FakeWait:
    """Deterministic stand-in for the loop's wait callable.

    Records every ``timeout`` it is asked to wait for and signals the loop to
    stop (returns True) once it has been called ``stop_after`` times.
    """

    def __init__(self, stop_after: int) -> None:
        self.stop_after = stop_after
        self.calls: list[float] = []

    def __call__(self, stop: threading.Event, timeout: float) -> bool:
        self.calls.append(timeout)
        return len(self.calls) >= self.stop_after


def test_runs_n_times_then_stops(make_config):
    run = Mock()
    wait = FakeWait(stop_after=3)
    runner.run_forever(make_config(), run=run, wait=wait, install_signal_handlers=False)
    assert run.call_count == 3
    assert len(wait.calls) == 3


def test_run_can_request_stop(make_config):
    stop = threading.Event()
    run_calls = {"n": 0}

    def run(config):
        run_calls["n"] += 1
        if run_calls["n"] >= 2:
            stop.set()

    def wait(s, timeout):
        return s.is_set()

    runner.run_forever(
        make_config(),
        run=run,
        stop_event=stop,
        wait=wait,
        install_signal_handlers=False,
    )
    assert run_calls["n"] == 2


def test_stop_preset_runs_nothing(make_config):
    stop = threading.Event()
    stop.set()
    run = Mock()
    wait = FakeWait(stop_after=1)
    runner.run_forever(
        make_config(),
        run=run,
        stop_event=stop,
        wait=wait,
        install_signal_handlers=False,
    )
    run.assert_not_called()
    assert wait.calls == []


def test_default_wait_and_monotonic(make_config):
    # Exercises the real default wait (stop.wait) and default monotonic.
    stop = threading.Event()
    calls = {"n": 0}

    def run(config):
        calls["n"] += 1
        stop.set()

    runner.run_forever(
        make_config(interval_seconds=0.0),
        run=run,
        stop_event=stop,
        install_signal_handlers=False,
    )
    assert calls["n"] == 1


def test_backoff_after_failure_then_cadence(make_config, caplog):
    cfg = make_config(
        interval_seconds=10.0,
        backoff_base_seconds=1.0,
        backoff_max_seconds=60.0,
        max_runtime_seconds=0.0,
    )
    run = Mock(side_effect=[ValueError("boom"), None])
    wait = FakeWait(stop_after=2)
    with caplog.at_level(logging.ERROR, logger="radar"):
        runner.run_forever(
            cfg,
            run=run,
            wait=wait,
            monotonic=lambda: 100.0,
            install_signal_handlers=False,
        )
    # First (failed) loop -> backoff base; second (success) loop -> cadence.
    # Constant monotonic makes elapsed 0, so cadence == interval.
    assert run.call_count == 2
    assert wait.calls == [1.0, 10.0]
    # logger.exception on failure records at ERROR level.
    assert any(record.levelno == logging.ERROR for record in caplog.records)


def test_backoff_is_capped(make_config):
    cfg = make_config(
        interval_seconds=0.0,
        backoff_base_seconds=1.0,
        backoff_max_seconds=5.0,
        max_runtime_seconds=0.0,
    )
    run = Mock(side_effect=ValueError("boom"))
    wait = FakeWait(stop_after=5)
    runner.run_forever(
        cfg,
        run=run,
        wait=wait,
        monotonic=lambda: 0.0,
        install_signal_handlers=False,
    )
    assert run.call_count == 5
    # 1*2**0, 1*2**1, 1*2**2, then capped at backoff_max (5.0).
    assert wait.calls == [1.0, 2.0, 4.0, 5.0, 5.0]


def test_backoff_survives_many_failures(make_config, caplog):
    caplog.set_level(logging.CRITICAL, logger="radar")
    cfg = make_config(
        interval_seconds=0.0,
        backoff_base_seconds=1.0,
        backoff_max_seconds=60.0,
        max_runtime_seconds=0.0,
    )
    run = Mock(side_effect=ValueError("boom"))
    wait = FakeWait(stop_after=2000)
    runner.run_forever(
        cfg,
        run=run,
        wait=wait,
        monotonic=lambda: 0.0,
        install_signal_handlers=False,
    )
    assert run.call_count == 2000
    assert all(delay <= cfg.backoff_max_seconds for delay in wait.calls)
    # base*2**min(failures, cap) far exceeds backoff_max here, so late delays pin to the cap.
    assert wait.calls[-1] == cfg.backoff_max_seconds


def test_backoff_base_zero_does_not_crash(make_config, caplog):
    caplog.set_level(logging.CRITICAL, logger="radar")
    cfg = make_config(
        interval_seconds=0.0,
        backoff_base_seconds=0.0,
        backoff_max_seconds=60.0,
        max_runtime_seconds=0.0,
    )
    run = Mock(side_effect=ValueError("boom"))
    wait = FakeWait(stop_after=2000)
    runner.run_forever(
        cfg,
        run=run,
        wait=wait,
        monotonic=lambda: 0.0,
        install_signal_handlers=False,
    )
    assert run.call_count == 2000
    assert all(delay == 0.0 for delay in wait.calls)


def test_no_signal_handlers_when_disabled(make_config, monkeypatch):
    calls = []
    monkeypatch.setattr(signal, "signal", lambda sig, handler: calls.append(sig))
    runner.run_forever(
        make_config(),
        run=Mock(),
        wait=FakeWait(stop_after=1),
        install_signal_handlers=False,
    )
    assert calls == []


def test_registers_signal_handlers_when_enabled(make_config, monkeypatch):
    registered: dict[int, Callable[..., None]] = {}
    monkeypatch.setattr(signal, "signal", lambda sig, handler: registered.__setitem__(sig, handler))
    stop = threading.Event()
    runner.run_forever(
        make_config(),
        run=Mock(),
        stop_event=stop,
        wait=FakeWait(stop_after=1),
        install_signal_handlers=True,
    )
    assert signal.SIGTERM in registered
    assert signal.SIGINT in registered
    # The registered handler must request stop when invoked.
    assert not stop.is_set()
    registered[signal.SIGTERM](signal.SIGTERM, None)
    assert stop.is_set()


def test_signal_registration_failure_is_tolerated(make_config, monkeypatch, caplog):
    def boom(sig, handler):
        raise ValueError("signal only works in main thread")

    monkeypatch.setattr(signal, "signal", boom)
    run = Mock()
    with caplog.at_level(logging.WARNING, logger="radar"):
        runner.run_forever(
            make_config(),
            run=run,
            wait=FakeWait(stop_after=1),
            install_signal_handlers=True,
        )
    assert run.call_count == 1
    assert any(record.levelno == logging.WARNING for record in caplog.records)


def test_execute_once_runs_the_phase(make_config):
    run = Mock()
    cfg = make_config(max_runtime_seconds=0.0)
    runner.execute_once(cfg, run)
    run.assert_called_once_with(cfg)


def test_execute_once_propagates_phase_exception(make_config):
    def boom(config):
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        runner.execute_once(make_config(max_runtime_seconds=0.0), boom)


def test_execute_once_timeout_disabled_when_zero(make_config, monkeypatch):
    armed: list[object] = []
    monkeypatch.setattr(signal, "setitimer", lambda *args: armed.append(args))
    runner.execute_once(make_config(max_runtime_seconds=0.0), Mock())
    assert armed == []
