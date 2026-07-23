"""Core unit of work performed on each radar iteration."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from radar.config import Config

logger = logging.getLogger(__name__)


def perform_iteration(config: Config) -> None:  # noqa: ARG001
    logger.info("performing iteration")


def run_once(config: Config) -> None:
    logger.info("iteration starting")
    perform_iteration(config)
    logger.info("iteration complete")
