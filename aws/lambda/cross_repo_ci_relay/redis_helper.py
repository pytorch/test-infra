"""Redis-backed helpers shared by webhook and result Lambdas."""

import hashlib
import json
import logging
from urllib.parse import urlparse

from github import Github
from github.GithubException import GithubException
import redis as redis_lib
import yaml

from config import RelayConfig
from utils import parse_allowlist_info_map

logger = logging.getLogger(__name__)

WHITELIST_REDIS_KEY = "oot:whitelist_yaml"
IN_PROGRESS_WORKFLOW_REDIS_KEY_PREFIX = "oot:in_progress_workflow:"
PENDING_PR_CLOSE_REDIS_KEY_PREFIX = "oot:pending_pr_close:"
CANCELLED_WORKFLOW_REDIS_KEY_PREFIX = "oot:cancelled_workflow:"

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


def _in_progress_workflow_key(*, upstream_repo: str, commit_sha: str) -> str:
    return f"{IN_PROGRESS_WORKFLOW_REDIS_KEY_PREFIX}{upstream_repo.strip().lower()}:{commit_sha}"


def _pending_pr_close_key(*, upstream_repo: str, commit_sha: str, downstream_repo: str) -> str:
    return (
        f"{PENDING_PR_CLOSE_REDIS_KEY_PREFIX}{upstream_repo.strip().lower()}:{commit_sha}:"
        f"{downstream_repo.strip().lower()}"
    )


def register_in_progress_workflow(
    config: RelayConfig,
    *,
    upstream_repo: str,
    commit_sha: str,
    downstream_repo: str,
    run_id: int,
    run_url: str,
    workflow_name: str,
) -> None:
    redis_client = get_redis(config)
    key = _in_progress_workflow_key(upstream_repo=upstream_repo, commit_sha=commit_sha)
    field = f"{downstream_repo}:{run_id}"
    payload = {
        "downstream_repo": downstream_repo,
        "run_id": run_id,
        "run_url": run_url,
        "workflow_name": workflow_name,
    }
    redis_client.hset(key, field, json.dumps(payload, separators=(",", ":")))
    ttl = redis_client.ttl(key)
    if ttl is None or ttl < 0:
        redis_client.expire(key, config.in_progress_workflow_ttl_seconds)
    logger.debug(
        "in-progress workflow registered key=%s field=%s ttl=%ss",
        key,
        field,
        config.in_progress_workflow_ttl_seconds,
    )


def remove_in_progress_workflow(
    config: RelayConfig,
    *,
    upstream_repo: str,
    commit_sha: str,
    downstream_repo: str,
    run_id: int,
) -> None:
    redis_client = get_redis(config)
    key = _in_progress_workflow_key(upstream_repo=upstream_repo, commit_sha=commit_sha)
    field = f"{downstream_repo}:{run_id}"
    redis_client.hdel(key, field)
    if redis_client.hlen(key) == 0:
        redis_client.delete(key)
    logger.debug("in-progress workflow removed key=%s field=%s", key, field)


def pop_in_progress_workflows(
    config: RelayConfig,
    *,
    upstream_repo: str,
    commit_sha: str,
) -> list[dict]:
    redis_client = get_redis(config)
    key = _in_progress_workflow_key(upstream_repo=upstream_repo, commit_sha=commit_sha)
    raw_map = redis_client.hgetall(key)
    if not raw_map:
        return []

    redis_client.delete(key)

    workflows: list[dict] = []
    for raw in raw_map.values():
        try:
            parsed = json.loads(raw)
        except Exception:
            continue
        if isinstance(parsed, dict):
            workflows.append(parsed)
    return workflows


def register_pending_pr_close(
    config: RelayConfig,
    *,
    upstream_repo: str,
    commit_sha: str,
    downstream_repo: str,
) -> None:
    redis_key = _pending_pr_close_key(
        upstream_repo=upstream_repo,
        commit_sha=commit_sha,
        downstream_repo=downstream_repo,
    )
    get_redis(config).set(redis_key, "1", ex=config.in_progress_workflow_ttl_seconds)
    logger.debug(
        "pending PR close registered key=%s ttl=%ss",
        redis_key,
        config.in_progress_workflow_ttl_seconds,
    )


def consume_pending_pr_close(
    config: RelayConfig,
    *,
    upstream_repo: str,
    commit_sha: str,
    downstream_repo: str,
) -> bool:
    redis_client = get_redis(config)
    redis_key = _pending_pr_close_key(
        upstream_repo=upstream_repo,
        commit_sha=commit_sha,
        downstream_repo=downstream_repo,
    )
    pipe = redis_client.pipeline()
    pipe.get(redis_key)
    pipe.delete(redis_key)
    value, _ = pipe.execute()
    found = value is not None
    if found:
        logger.info("pending PR close consumed key=%s", redis_key)
    return found


def _cancelled_workflow_key(run_url: str) -> str:
    run_url_hash = hashlib.sha256(run_url.strip().encode("utf-8")).hexdigest()
    return f"{CANCELLED_WORKFLOW_REDIS_KEY_PREFIX}{run_url_hash}"


def register_cancelled_workflow(config: RelayConfig, *, run_url: str) -> None:
    run_url = run_url.strip()
    if not run_url:
        return

    redis_key = _cancelled_workflow_key(run_url)
    get_redis(config).set(redis_key, "1", ex=config.in_progress_workflow_ttl_seconds)
    logger.debug(
        "cancelled workflow registered key=%s ttl=%ss",
        redis_key,
        config.in_progress_workflow_ttl_seconds,
    )


def consume_cancelled_workflow(config: RelayConfig, *, run_url: str) -> bool:
    run_url = run_url.strip()
    if not run_url:
        return False

    redis_client = get_redis(config)
    redis_key = _cancelled_workflow_key(run_url)
    pipe = redis_client.pipeline()
    pipe.get(redis_key)
    pipe.delete(redis_key)
    value, _ = pipe.execute()
    found = value is not None
    if found:
        logger.info("cancelled workflow consumed key=%s", redis_key)
    return found
