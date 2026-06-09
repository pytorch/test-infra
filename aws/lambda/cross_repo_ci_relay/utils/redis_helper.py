import json
import logging
import os
import time
from typing import cast
from urllib.parse import quote

import redis as redis_lib
from redis.exceptions import RedisError

from .config import RelayConfig
from .misc import (
    CallbackState,
    CallbackStateRecord,
    DISPATCH_CHECK_RUN_ID,
    HTTPException,
)


logger = logging.getLogger(__name__)

_ALLOWLIST_CACHE_KEY = "crcr:allowlist_yaml"
_STATE_PREFIX = "crcr:state:"
_RATE_LIMIT_PREFIX = "crcr:rate:"
_DISPATCH_WORKFLOW_PREFIX = "crcr:dispatch_workflow:"
_CHECK_RUN_WANTED_PREFIX = "crcr:check_run_wanted:"
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


def check_rate_limit(
    config: RelayConfig,
    repo: str,
    client: redis_lib.Redis | None = None,
) -> bool:
    """Check if repo is within rate limit using sliding window.

    Returns True if allowed, False if rate exceeded.
    Raises HTTPException(500) on Redis failure (fail-closed).
    """
    try:
        if client is None:
            client = create_client(config)

        key = f"{_RATE_LIMIT_PREFIX}{repo}"
        now = time.time()
        window_start = now - 60

        member = f"{now}:{repo}"
        client.zadd(key, {member: now})
        client.zremrangebyscore(key, "-inf", window_start)
        count = client.zcard(key)
        client.expire(key, 120)

        if count > config.rate_limit_per_min:
            logger.warning(
                "rate limit exceeded key=%s count=%d limit=%d",
                key,
                count,
                config.rate_limit_per_min,
            )
            return False
        return True
    except RedisError as e:
        logger.exception("redis rate limit check failed")
        raise HTTPException(500, f"rate limit check failed: {e}") from e


def set_dispatch_workflow(
    config: RelayConfig,
    head_sha: str,
    downstream_repo: str,
    status: str,
    check_run_id: str,
    conclusion: str | None,
    job_url: str | None,
    run_id: str | None = None,
    workflow_name: str | None = None,
    client: redis_lib.Redis | None = None,
) -> None:
    """Store the latest downstream job summary keyed by (head_sha, downstream_repo)."""
    try:
        if client is None:
            client = create_client(config)
        key = f"{_DISPATCH_WORKFLOW_PREFIX}{head_sha}:{downstream_repo}"
        value = json.dumps(
            {
                "status": status,
                "check_run_id": check_run_id,
                "conclusion": conclusion,
                "job_url": job_url,
                "run_id": run_id,
                "workflow_name": workflow_name,
            }
        )
        client.setex(key, config.oot_status_ttl, value)
    except RedisError:
        logger.exception("set_dispatch_workflow: redis error")


def get_dispatch_workflow(
    config: RelayConfig,
    head_sha: str,
    downstream_repo: str,
    client: redis_lib.Redis | None = None,
) -> dict | None:
    """Return the latest job summary for (head_sha, downstream_repo), or None if not found."""
    try:
        if client is None:
            client = create_client(config)
        key = f"{_DISPATCH_WORKFLOW_PREFIX}{head_sha}:{downstream_repo}"
        val = client.get(key)
        if val is None:
            return None
        return json.loads(val)
    except (RedisError, json.JSONDecodeError, TypeError):
        logger.exception("get_dispatch_workflow: failed")
        return None


def mark_check_run_wanted(
    config: RelayConfig,
    head_sha: str,
    downstream_repo: str,
    client: redis_lib.Redis | None = None,
) -> None:
    """Record that an upstream check run is wanted for this (head_sha, repo)."""
    try:
        if client is None:
            client = create_client(config)
        key = f"{_CHECK_RUN_WANTED_PREFIX}{head_sha}:{downstream_repo}"
        client.setex(key, config.oot_status_ttl, "1")
    except RedisError:
        logger.exception("mark_check_run_wanted: redis error")


def is_check_run_wanted(
    config: RelayConfig,
    head_sha: str,
    downstream_repo: str,
    client: redis_lib.Redis | None = None,
) -> bool:
    """Return True if an upstream check run is wanted for this (head_sha, repo)."""
    try:
        if client is None:
            client = create_client(config)
        key = f"{_CHECK_RUN_WANTED_PREFIX}{head_sha}:{downstream_repo}"
        return bool(client.exists(key))
    except RedisError:
        logger.exception("is_check_run_wanted: redis error")
        return False


def _state_key(delivery_id: str, downstream_repo: str, check_run_id: str) -> str:
    """Redis key for callback state machine.

    Keyed by delivery_id + repo + check_run_id to support per-execution state tracking.
    check_run_id is unique per job execution, enabling replay attack detection.
    """
    return f"{_STATE_PREFIX}{delivery_id}:{downstream_repo}:{check_run_id}"


def get_callback_state(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    check_run_id: str,
    client: redis_lib.Redis | None = None,
) -> CallbackStateRecord | None:
    """Get callback state record from Redis, or None if no record exists.

    Returns a record containing state, timestamp, and optional job metadata.
    """
    try:
        if client is None:
            client = create_client(config)
        key = _state_key(delivery_id, downstream_repo, check_run_id)
        value = client.get(key)
        if value is None:
            return None
        data = json.loads(value)
        return CallbackStateRecord(
            state=CallbackState(data["state"]),
            timestamp=data["timestamp"],
            job_name=data["job_name"],
            run_id=data["run_id"],
        )
    except RedisError:
        logger.exception("redis temporary outage or unreachable")
    except Exception:
        logger.exception("redis get_callback_state failed")
    return None


def set_callback_state(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    check_run_id: str,
    state: CallbackState,
    timestamp: float,
    job_name: str | None = None,
    run_id: int | None = None,
    client: redis_lib.Redis | None = None,
) -> None:
    """Set callback state with timestamp in Redis.

    State transition validation:

    DISPATCHED state (webhook-side):
    - None -> DISPATCHED: accept (initial dispatch)
    - DISPATCHED -> DISPATCHED: reject (duplicate webhook)

    IN_PROGRESS state (callback-side):
    - None -> IN_PROGRESS: accept (first callback for this check_run_id)
    - IN_PROGRESS -> IN_PROGRESS: reject (replay attack for same check_run_id)

    COMPLETED state (callback-side):
    - None -> COMPLETED: reject (no prior in_progress)
    - IN_PROGRESS -> COMPLETED: accept (normal completion)
    - COMPLETED -> COMPLETED: reject (duplicate)
    """
    error_msg = ""
    try:
        if client is None:
            client = create_client(config)

        if check_run_id == DISPATCH_CHECK_RUN_ID and state != CallbackState.DISPATCHED:
            error_msg = (
                "check_run_id '%s' is preserved for DISPATCHED state only, rejecting invalid state=%s"
                % (
                    DISPATCH_CHECK_RUN_ID,
                    state.value,
                )
            )

        key = _state_key(delivery_id, downstream_repo, check_run_id)

        current_record = get_callback_state(
            config, delivery_id, downstream_repo, check_run_id, client
        )

        if state == CallbackState.DISPATCHED:
            if current_record is not None:
                error_msg = "rejecting duplicate DISPATCHED key=%s" % key
        elif state == CallbackState.IN_PROGRESS:
            if current_record is not None:
                error_msg = (
                    "rejecting replay attack IN_PROGRESS for same "
                    "check_run_id=%s, downstream_repo=%s, job_name=%s, run_id=%s"
                    % (
                        check_run_id,
                        downstream_repo,
                        job_name,
                        run_id,
                    )
                )

        elif state == CallbackState.COMPLETED:
            if current_record is None:
                error_msg = (
                    "rejecting COMPLETED without prior IN_PROGRESS "
                    "key=%s, downstream_repo=%s, job_name=%s, run_id=%s"
                    % (
                        key,
                        downstream_repo,
                        job_name,
                        run_id,
                    )
                )
            elif current_record.state == CallbackState.COMPLETED:
                error_msg = "rejecting duplicate COMPLETED key=%s" % key
            elif current_record.state != CallbackState.IN_PROGRESS:
                error_msg = (
                    "rejecting abnormal state transition %s -> COMPLETED "
                    "key=%s, downstream_repo=%s, job_name=%s, run_id=%s"
                    % (
                        current_record.state.value,
                        key,
                        downstream_repo,
                        job_name,
                        run_id,
                    )
                )

        if error_msg:
            logger.warning(error_msg)
            raise AssertionError(error_msg)

        data: dict = {
            "state": state.value,
            "timestamp": timestamp,
            "job_name": job_name,
            "run_id": run_id,
        }
        client.setex(key, config.oot_status_ttl, json.dumps(data))
        logger.info(
            "callback state set key=%s state=%s timestamp=%s job_name=%s run_id=%s",
            key,
            state.value,
            timestamp,
            job_name,
            run_id,
        )
    except RedisError:
        logger.exception("set_callback_state: redis is temporary outage or unreachable")
        raise
    except Exception:
        logger.exception("redis set_callback_state failed")
        raise
