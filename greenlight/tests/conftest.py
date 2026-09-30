import dataclasses
import logging
import os

import pytest

from greenlight import guards, verdict
from greenlight.config import Config


@pytest.fixture(autouse=True)
def _no_real_watchdog_exit(monkeypatch):
    """Neutralise the shared hard watchdog's exit action so no test can call os._exit."""
    monkeypatch.setattr(guards._WATCHDOG, "_on_expire", lambda: None)


@pytest.fixture(autouse=True)
def _no_real_merge_rule_lookup(monkeypatch):
    """Refuse ``verdict.has_covering_rule``, which reads the merge rules from live GitHub.

    ``_run_full`` looks the function up on the module at call time, which is the attribute patched
    here; ``set_eligible`` swaps a fake in. A test module that imports the function itself binds the
    real one at collection, before this runs, and hands it fake clients.
    """

    def unreachable(*_args: object, **_kwargs: object) -> bool:
        raise AssertionError("a test reached the live merge-rule lookup")

    monkeypatch.setattr(verdict, "has_covering_rule", unreachable)


class _FakeEligibility:
    """Stand-in for ``verdict.has_covering_rule`` that records each call and answers from a fixed set."""

    def __init__(self, authors: frozenset[str]) -> None:
        self.authors = authors
        self.calls: list[tuple[str, str, int, str, str | None]] = []

    def __call__(self, token: str, repo: str, pr_number: int, head_sha: str, author: str | None) -> bool:
        self.calls.append((token, repo, pr_number, head_sha, author))
        return author in self.authors


@pytest.fixture
def set_eligible(monkeypatch):
    """Replace ``verdict.has_covering_rule`` with a fake under which exactly the given authors are eligible.

    ``set_eligible("alice")`` returns the installed fake; its ``calls`` record every lookup.
    """

    def _install(*authors: str) -> _FakeEligibility:
        fake = _FakeEligibility(frozenset(authors))
        monkeypatch.setattr(verdict, "has_covering_rule", fake)
        return fake

    return _install


@pytest.fixture(autouse=True)
def _clean_greenlight_env(monkeypatch):
    """Remove greenlight env vars so tests are isolated from the real environment."""
    for key in list(os.environ):
        if key.startswith("PYTORCH_GREENLIGHT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("BOT_LOGIN", raising=False)


@pytest.fixture(autouse=True)
def reset_greenlight_logger():
    """Give each test a clean 'greenlight' logger and restore the original state afterwards.

    Handlers are cleared and propagate is forced on so that ``caplog`` (which
    listens on the root logger) can observe records from the ``greenlight`` tree in
    tests that do not call ``configure_logging`` themselves.
    """
    logger = logging.getLogger("greenlight")
    saved_handlers = logger.handlers[:]
    saved_level = logger.level
    saved_propagate = logger.propagate

    logger.handlers = []
    logger.setLevel(logging.WARNING)
    logger.propagate = True
    try:
        yield logger
    finally:
        logger.handlers = saved_handlers
        logger.setLevel(saved_level)
        logger.propagate = saved_propagate


@pytest.fixture
def make_config():
    """Factory for a Config with fast, side-effect-free timings.

    Pass keyword overrides for any field, e.g. ``make_config(interval_seconds=10.0)``.
    """

    def _make(**overrides):
        base = Config(
            interval_seconds=1.0,
            log_level="INFO",
            lock_path=None,
            max_runtime_seconds=0.0,
            backoff_base_seconds=1.0,
            backoff_max_seconds=60.0,
        )
        return dataclasses.replace(base, **overrides)

    return _make


@pytest.fixture
def tmp_lock_path(tmp_path):
    return str(tmp_path / "greenlight.lock")


class _RecordingWatchdog:
    """Structural stand-in for the hard watchdog that records interactions instead of arming a thread."""

    def __init__(self) -> None:
        self.registered: list[float] = []
        self.cleared = 0
        self.started = 0

    def start(self) -> None:
        self.started += 1

    def register(self, deadline_monotonic: float) -> None:
        self.registered.append(deadline_monotonic)

    def clear(self) -> None:
        self.cleared += 1


@pytest.fixture
def recording_watchdog():
    return _RecordingWatchdog()
