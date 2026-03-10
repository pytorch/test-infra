"""Redis-backed helpers shared by webhook and result Lambdas."""

import hashlib
import logging
import time
from urllib.parse import urlparse

from github import Github
from github.GithubException import GithubException
import redis as redis_lib
import yaml

from config import RelayConfig
from utils import parse_allowlist_info_map

logger = logging.getLogger(__name__)

WHITELIST_REDIS_KEY = "oot:whitelist_yaml"
RESULT_TOKEN_REDIS_KEY_PREFIX = "oot:result_token:"

_redis_client: redis_lib.Redis | None = None


def _read_whitelist_from_github_url(url: str) -> str:
    """Fetch whitelist YAML from a GitHub blob URL (https://github.com/<owner>/<repo>/blob/<ref>/<path>)."""
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    if (
        parsed.scheme not in ("http", "https")
        or parsed.netloc != "github.com"
        or len(parts) < 5
        or parts[2] != "blob"
    ):
        raise RuntimeError(
            "Invalid GitHub whitelist URL. Expected format: "
            "https://github.com/<owner>/<repo>/blob/<ref>/<path/to/file>"
        )

    owner, repo, _, ref = parts[:4]
    file_path = "/".join(parts[4:])

    try:
        gh = Github(timeout=20)
        repo_obj = gh.get_repo(f"{owner}/{repo}")
        content_file = repo_obj.get_contents(file_path, ref=ref)
        if isinstance(content_file, list):
            raise RuntimeError(f"GitHub URL points to a directory, not a file: {url}")
        return content_file.decoded_content.decode("utf-8")
    except GithubException as exc:
        raise RuntimeError(
            f"Failed to fetch whitelist from GitHub URL {url}: {exc}"
        ) from exc


def get_redis(config: RelayConfig) -> redis_lib.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis_lib.from_url(config.redis_url, decode_responses=True)
    return _redis_client


def load_allowlist_info_map(config: RelayConfig) -> dict[str, dict]:
    """Return device → {level, repo, url, oncall}, loaded from Redis cache or a GitHub URL."""
    redis_client = get_redis(config)
    cached = redis_client.get(WHITELIST_REDIS_KEY)
    if cached is not None:
        logger.debug("whitelist cache hit key=%s", WHITELIST_REDIS_KEY)
        yaml_str = cached
    else:
        logger.info(
            "whitelist cache miss - loading %s and caching for %ss",
            config.whitelist_url,
            config.whitelist_ttl_seconds,
        )

        yaml_str = _read_whitelist_from_github_url(config.whitelist_url)

        redis_client.setex(WHITELIST_REDIS_KEY, config.whitelist_ttl_seconds, yaml_str)
        logger.debug(
            "whitelist cached %d bytes in Redis key=%s",
            len(yaml_str),
            WHITELIST_REDIS_KEY,
        )

    raw: dict = yaml.safe_load(yaml_str) or {}
    mapping = parse_allowlist_info_map(raw)
    logger.debug("allowlist loaded: %d device(s)", len(mapping))
    return mapping


def register_result_token(config: RelayConfig, token: str, token_expiry: int) -> bool:
    token = token.strip()
    if not token:
        return False

    ttl_seconds = max(token_expiry - int(time.time()), 1)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    redis_key = f"{RESULT_TOKEN_REDIS_KEY_PREFIX}{token_hash}"

    created = bool(
        get_redis(config).set(
            redis_key,
            "1",
            ex=ttl_seconds,
            nx=True,
        )
    )
    if created:
        logger.debug("result token accepted key=%s ttl=%ss", redis_key, ttl_seconds)
    else:
        logger.warning("result token replay detected key=%s", redis_key)
    return created
