import logging
import sys

import pytest

from radar.log import configure_logging


def test_configure_sets_level_and_single_stdout_handler():
    configure_logging("DEBUG")
    logger = logging.getLogger("radar")

    assert logger.level == logging.DEBUG
    assert len(logger.handlers) == 1

    handler = logger.handlers[0]
    assert isinstance(handler, logging.StreamHandler)
    assert handler.stream is sys.stdout
    assert logger.propagate is False


def test_default_level_is_info():
    configure_logging()
    logger = logging.getLogger("radar")
    assert logger.level == logging.INFO


def test_idempotent_keeps_single_handler():
    configure_logging("INFO")
    configure_logging("INFO")
    logger = logging.getLogger("radar")
    assert len(logger.handlers) == 1


def test_invalid_level_raises():
    with pytest.raises(ValueError):
        configure_logging("NOT_A_REAL_LEVEL")
