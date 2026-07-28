import dataclasses
import logging
import os

import pytest

from greenlight.config import Config


@pytest.fixture(autouse=True)
def _clean_greenlight_env(monkeypatch):
    """Remove any PYTORCH_GREENLIGHT_* env vars so tests are isolated from the real environment."""
    for key in list(os.environ):
        if key.startswith("PYTORCH_GREENLIGHT_"):
            monkeypatch.delenv(key, raising=False)


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
            interval_seconds=0.0,
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
