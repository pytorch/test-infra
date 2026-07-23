"""Select, gate, and score open PRs and decide which need a code review."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from radar.config import Config

logger = logging.getLogger(__name__)


def run(config: Config) -> None:
    logger.info("planning investigations")
    logger.debug("radar config: %r", config)
