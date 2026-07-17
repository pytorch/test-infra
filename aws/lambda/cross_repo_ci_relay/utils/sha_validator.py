"""Validate that a commit SHA exists on pytorch/pytorch via GitHub API.

Used by the nightly/periodic callback path to verify that the self-reported
dispatch_id (commit SHA) is real before accepting the result.  A TTL cache
avoids redundant API calls when multiple downstream repos report against the
same SHA.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import github


logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 3600  # 1 hour
_NEGATIVE_CACHE_TTL_SECONDS = 300  # 5 minutes for 404s


@dataclass
class _CacheEntry:
    exists: bool
    timestamp: float


_SHA_CACHE: dict[str, _CacheEntry] = {}
_REPO_CACHE: dict[str, object] = {}


def _evict_expired() -> None:
    now = time.monotonic()
    expired = []
    for k, entry in _SHA_CACHE.items():
        ttl = _CACHE_TTL_SECONDS if entry.exists else _NEGATIVE_CACHE_TTL_SECONDS
        if now - entry.timestamp > ttl:
            expired.append(k)
    for k in expired:
        del _SHA_CACHE[k]


def _get_repo(gh_client: github.Github, upstream_repo: str):
    """Return a cached repo handle to avoid redundant API calls."""
    if upstream_repo not in _REPO_CACHE:
        _REPO_CACHE[upstream_repo] = gh_client.get_repo(upstream_repo)
    return _REPO_CACHE[upstream_repo]


def validate_sha(
    upstream_repo: str,
    sha: str,
    gh_client: github.Github,
) -> bool:
    """Return True if ``sha`` exists on ``upstream_repo``, False otherwise.

    Results are cached: valid SHAs for 1 hour, invalid (404) SHAs for 5 minutes.
    The repo handle is also cached to halve API calls per cache miss.

    Transient API errors (500, 403 rate-limit) fail open — since nightly results
    are informational, a GitHub outage should not reject valid callbacks.
    """
    _evict_expired()

    cache_key = f"{upstream_repo}:{sha}"
    if cache_key in _SHA_CACHE:
        return _SHA_CACHE[cache_key].exists

    try:
        repo = _get_repo(gh_client, upstream_repo)
        repo.get_commit(sha)
        _SHA_CACHE[cache_key] = _CacheEntry(exists=True, timestamp=time.monotonic())
        return True
    except github.GithubException as exc:
        if exc.status == 404:
            logger.warning("SHA %s does not exist on %s", sha, upstream_repo)
            _SHA_CACHE[cache_key] = _CacheEntry(
                exists=False, timestamp=time.monotonic()
            )
            return False
        # Transient errors (500, 403 rate-limit, etc.) — fail open since
        # nightly is informational and should not be blocked by GitHub outages.
        logger.warning(
            "GitHub API error (%d) validating SHA %s on %s, failing open",
            exc.status,
            sha,
            upstream_repo,
        )
        return True
