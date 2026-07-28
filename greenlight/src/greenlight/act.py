"""Turn review decisions into PR approvals or revocations."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from greenlight.config import Config

logger = logging.getLogger(__name__)


def run(config: Config) -> None:
    logger.info("applying approval decisions")
    logger.debug("greenlight config: %r", config)
