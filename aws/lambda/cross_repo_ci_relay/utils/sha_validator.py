"""Validate that a commit SHA exists on pytorch/pytorch via GitHub API.

Used by the nightly/periodic callback path to verify that the self-reported
dispatch_id (commit SHA) is real before accepting the result.  A TTL cache
avoids redundant API calls when multiple downstream repos report against the
same SHA.
"""

from __future__ import annotations

import logging
import time

import github


logger = logging.getLogger(__name__)

_SHA_CACHE: dict[str, float] = {}
_CACHE_TTL_SECONDS = 3600  # 1 hour


def _evict_expired() -> None:
    now = time.monotonic()
    expired = [k for k, v in _SHA_CACHE.items() if now - v > _CACHE_TTL_SECONDS]
    for k in expired:
        del _SHA_CACHE[k]


def validate_sha(
    upstream_repo: str,
    sha: str,
    gh_client: github.Github | None = None,
) -> bool:
    """Return True if ``sha`` exists on ``upstream_repo``, False otherwise.

    Results are cached for ``_CACHE_TTL_SECONDS`` to avoid repeated API calls
    when multiple downstream repos report against the same nightly SHA.
    """
    _evict_expired()

    cache_key = f"{upstream_repo}:{sha}"
    if cache_key in _SHA_CACHE:
        return True

    if gh_client is None:
        gh_client = github.Github(timeout=10)

    try:
        gh_client.get_repo(upstream_repo).get_commit(sha)
        _SHA_CACHE[cache_key] = time.monotonic()
        return True
    except github.GithubException as exc:
        if exc.status == 404:
            logger.warning("SHA %s does not exist on %s", sha, upstream_repo)
            return False
        logger.exception(
            "GitHub API error validating SHA %s on %s",
            sha,
            upstream_repo,
        )
        raise
