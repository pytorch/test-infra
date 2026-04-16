import logging
import os
from typing import cast
from urllib.parse import quote

import redis as redis_lib
from redis.exceptions import RedisError

from .config import RelayConfig
from .misc import TimingPhase


logger = logging.getLogger(__name__)

_ALLOWLIST_CACHE_KEY = "crcr:allowlist_yaml"
_TIMING_PREFIX = "crcr:timing:"
_cached_client: redis_lib.Redis | None = None
_cached_client_url: str | None = None


def _parse_endpoint(endpoint: str) -> tuple[str, int]:
    host = endpoint.strip()

    if not host:
        raise RuntimeError("REDIS_ENDPOINT must not be empty")

    if host.startswith(("redis://", "rediss://")):
        raise RuntimeError(
            "REDIS_ENDPOINT must be a hostname or host:port, not a redis URL"
        )

    if "/" in host:
        raise RuntimeError("REDIS_ENDPOINT must be a hostname or host:port")

    port = 6379
    if ":" in host:
        maybe_host, maybe_port = host.rsplit(":", 1)
        if not maybe_port.isdigit():
            raise RuntimeError(f"REDIS_ENDPOINT has invalid port: {maybe_port!r}")
        host, port = maybe_host, int(maybe_port)

    return host, port


def _parse_login(login: str) -> tuple[str, str]:
    login = login.strip()
    if not login:
        return "", ""

    if ":" in login:
        username, password = login.split(":", 1)
        return username, password

    # ElastiCache auth_token config provides only a password, not a username.
    return "", login


def _build_url(config: RelayConfig) -> str:
    host, port = _parse_endpoint(config.redis_endpoint or "")
    auth = ""
    username, password = _parse_login(config.redis_login or "")
    if password and username:
        auth = f"{quote(username, safe='')}:{quote(password, safe='')}@"
    elif password:
        auth = f":{quote(password, safe='')}@"
    # Use TLS (rediss://) on AWS Lambda where ElastiCache requires it;
    # fall back to plain redis:// for local development.
    # AWS_LAMBDA_FUNCTION_NAME is automatically set by the Lambda runtime.
    scheme = "rediss" if os.environ.get("AWS_LAMBDA_FUNCTION_NAME") else "redis"
    return f"{scheme}://{auth}{host}:{port}/0"


def create_client(config: RelayConfig) -> redis_lib.Redis:
    """Create or reuse a Redis client for the given config."""
    global _cached_client
    global _cached_client_url
    try:
        redis_url = _build_url(config)
        if _cached_client is not None and _cached_client_url == redis_url:
            return _cached_client

        client = redis_lib.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
    except Exception:
        logger.exception("Error creating Redis client")
        raise RuntimeError("Failed to create Redis client")
    _cached_client = client
    _cached_client_url = redis_url
    return client


def get_cached_yaml(
    config: RelayConfig, client: redis_lib.Redis | None = None
) -> str | None:
    """Return cached allowlist YAML string, or None on cache miss or Redis error."""
    try:
        if client is None:
            client = create_client(config)
        value = client.get(_ALLOWLIST_CACHE_KEY)
        if value is not None:
            logger.info("allowlist cache hit key=%s", _ALLOWLIST_CACHE_KEY)
        return cast(str | None, value)
    except RedisError:
        logger.exception(
            "redis cache read failed, falling back to source",
        )
        return None


def set_cached_yaml(
    config: RelayConfig, yaml_str: str, client: redis_lib.Redis | None = None
) -> None:
    """Cache allowlist YAML string with TTL. Logs and ignores Redis errors."""
    try:
        if client is None:
            client = create_client(config)
        client.setex(_ALLOWLIST_CACHE_KEY, config.allowlist_ttl_seconds, yaml_str)
        logger.info(
            "allowlist cached %d bytes key=%s", len(yaml_str), _ALLOWLIST_CACHE_KEY
        )
    except RedisError:
        logger.exception("redis cache write failed, continuing without cache")


def _timing_key(delivery_id: str, downstream_repo: str, phase: TimingPhase) -> str:
    # delivery_id is GitHub's globally-unique X-GitHub-Delivery, so it disambiguates
    # retries/reruns that share a head_sha.  downstream_repo keeps the fan-out
    # dimension since one delivery dispatches to many repos with independent timings.
    return f"{_TIMING_PREFIX}{delivery_id}:{downstream_repo}:{phase.value}"


def set_timing(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    phase: TimingPhase,
    ts: float,
    client: redis_lib.Redis | None = None,
) -> None:
    """Set timestamp for a given delivery+repo. Best-effort."""
    try:
        if client is None:
            client = create_client(config)
        key = _timing_key(delivery_id, downstream_repo, phase)
        client.setex(key, config.oot_status_ttl, ts)
        logger.info("%s timing cached key=%s", phase.value, key)
    except Exception:
        logger.exception("redis set_timing failed phase=%s", phase.value)


def get_timing(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    phase: TimingPhase,
    client: redis_lib.Redis | None = None,
) -> float | None:
    """Return the stored timestamp as a float, or None on cache miss / Redis error.

    Best-effort: timing data is a reporting-only enrichment, so Redis failures
    must not break the result handler.  Errors are logged and swallowed.
    """
    try:
        if client is None:
            client = create_client(config)
        key = _timing_key(delivery_id, downstream_repo, phase)
        value = client.get(key)
        if value is None:
            return None
        return float(value)
    except Exception:
        logger.exception("redis get_timing failed phase=%s", phase.value)
        return None
