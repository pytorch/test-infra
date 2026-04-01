import logging
import os
from urllib.parse import quote

import redis as redis_lib
from config import RelayConfig


logger = logging.getLogger(__name__)

_ALLOWLIST_CACHE_KEY = "crcr:allowlist_yaml"
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


def _build_url(config: RelayConfig) -> str:
    host, port = _parse_endpoint(config.redis_endpoint or "")
    auth = ""
    login = (config.redis_login or "").strip()
    if login:
        username, password = (login.split(":", 1) + [""])[:2]
        if password:
            auth = f"{quote(username, safe='')}:{quote(password, safe='')}@"
        else:
            auth = f"{quote(username, safe='')}@"
    # Use TLS (rediss://) on AWS Lambda where ElastiCache requires it;
    # fall back to plain redis:// for local development.
    # AWS_LAMBDA_FUNCTION_NAME is automatically set by the Lambda runtime.
    scheme = "rediss" if os.environ.get("AWS_LAMBDA_FUNCTION_NAME") else "redis"
    return f"{scheme}://{auth}{host}:{port}/0"


def create_client(config: RelayConfig) -> redis_lib.Redis:
    """Create or reuse a Redis client for the given config."""
    global _cached_client
    global _cached_client_url

    redis_url = _build_url(config)
    if _cached_client is not None and _cached_client_url == redis_url:
        return _cached_client

    client = redis_lib.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=2,
        socket_timeout=2,
    )
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
        return value
    except redis_lib.exceptions.RedisError as exc:
        logger.warning("redis cache read failed, falling back to source: %s", exc)
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
    except redis_lib.exceptions.RedisError as exc:
        logger.warning("redis cache write failed, continuing without cache: %s", exc)
