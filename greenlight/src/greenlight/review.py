"""Fetch open PRs from trusted authors in pytorch/pytorch and log them.

The trusted-author set is the match rule. Risk-scoring and triggering the AI
code-review workflow are the seam to fill.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import github_client

if TYPE_CHECKING:
    from collections.abc import Callable

    from greenlight.config import Config
    from greenlight.github_client import OpenPR

logger = logging.getLogger(__name__)

TARGET_REPO = "pytorch/pytorch"
TRUSTED_AUTHORS: set[str] = {
    "albanD",  # Alban Desmaison
    "jathu",  # Jathu Satkunarajah
    "atalman",  # Andrey Talman
    "huydhn",  # Huy Do
    "izaitsevfb",  # Ivan Zaitsev
    "georgehong",  # George Hong
    "jeanschmidt",  # Jean Schmidt
}


def _default_fetch(config: Config) -> list[OpenPR]:
    if not config.github_token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    client = github_client.build_client(config.github_token)
    return github_client.list_open_prs_by_authors(client, TARGET_REPO, TRUSTED_AUTHORS)


def run(config: Config, *, fetch: Callable[[Config], list[OpenPR]] = _default_fetch) -> None:
    logger.info("reviewing open PRs from trusted authors in %s", TARGET_REPO)
    logger.debug("greenlight config: %r", config)
    prs = fetch(config)
    logger.info("found %d open PR(s) from %d author(s) in %s", len(prs), len(TRUSTED_AUTHORS), TARGET_REPO)
    for pr in prs:
        logger.info("open PR #%d by %s: %s (%s)", pr.number, pr.author, pr.title, pr.url)
