import json
import logging
import os
import time
from typing import cast
from urllib.parse import quote

import redis as redis_lib
from redis.exceptions import RedisError

from .config import RelayConfig
from .misc import CallbackState, CallbackStateRecord, DISPATCH_RUN_ID, HTTPException


logger = logging.getLogger(__name__)

_ALLOWLIST_CACHE_KEY = "oot:allowlist_yaml"
_STATE_PREFIX = "oot:state:"
_RATE_LIMIT_PREFIX = "oot:rate:"
_IN_PROGRESS_ZSET = "oot:in_progress"
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


def _state_key(
    delivery_id: str, downstream_repo: str, run_id: int, run_attempt: int
) -> str:
    """Redis key for callback state machine.

    Keyed by delivery_id + repo + run_id + run_attempt to support per-execution state tracking.
    run_id + run_attempt uniquely identify a workflow run execution.
    """
    return f"{_STATE_PREFIX}{delivery_id}:{downstream_repo}:{run_id}:{run_attempt}"


def get_callback_state(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    run_id: int,
    run_attempt: int,
    client: redis_lib.Redis | None = None,
) -> CallbackStateRecord | None:
    """Get callback state record from Redis, or None if no record exists.

    Returns a record containing state, timestamp, and any stored payload.
    """
    try:
        if client is None:
            client = create_client(config)
        key = _state_key(delivery_id, downstream_repo, run_id, run_attempt)
        value = client.get(key)
        if value is None:
            return None
        data = json.loads(value)
        return CallbackStateRecord(
            state=CallbackState(data["state"]),
            timestamp=data["timestamp"],
            payload=data.get("payload"),
        )
    except RedisError:
        logger.exception("redis temporary outage or unreachable")
    except Exception:
        logger.exception("redis get_callback_state failed to parse record")
    return None


def set_callback_state(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    run_id: int,
    run_attempt: int,
    state: CallbackState,
    timestamp: float,
    workflow_name: str | None = None,
    client: redis_lib.Redis | None = None,
    payload: dict | None = None,
) -> None:
    """Set callback state with timestamp in Redis.

    State transition validation:

    DISPATCHED state (webhook-side):
    - None -> DISPATCHED: accept (initial dispatch)
    - DISPATCHED -> DISPATCHED: reject (duplicate webhook)

    IN_PROGRESS state (callback-side):
    - None -> IN_PROGRESS: accept (first callback for this run_id + run_attempt)
    - IN_PROGRESS -> IN_PROGRESS: reject (replay attack for same run_id + run_attempt)

    COMPLETED state (callback-side):
    - None -> COMPLETED: reject (no prior in_progress)
    - IN_PROGRESS -> COMPLETED: accept (normal completion)
    - COMPLETED -> COMPLETED: reject (duplicate)
    """
    error_msg = ""
    try:
        if client is None:
            client = create_client(config)

        if run_id == DISPATCH_RUN_ID and state != CallbackState.DISPATCHED:
            error_msg = (
                "run_id '%s' is preserved for DISPATCHED state only, rejecting invalid state=%s"
                % (
                    DISPATCH_RUN_ID,
                    state.value,
                )
            )

        key = _state_key(delivery_id, downstream_repo, run_id, run_attempt)

        current_record = get_callback_state(
            config, delivery_id, downstream_repo, run_id, run_attempt, client
        )

        if state == CallbackState.DISPATCHED:
            if current_record is not None:
                error_msg = "rejecting duplicate DISPATCHED key=%s" % key
        elif state == CallbackState.IN_PROGRESS:
            if current_record is not None:
                error_msg = (
                    "rejecting replay attack IN_PROGRESS for same "
                    "run_id=%s, run_attempt=%s, downstream_repo=%s, workflow_name=%s"
                    % (
                        run_id,
                        run_attempt,
                        downstream_repo,
                        workflow_name,
                    )
                )

        elif state == CallbackState.COMPLETED:
            if current_record is None:
                error_msg = (
                    "rejecting COMPLETED without prior IN_PROGRESS "
                    "key=%s, downstream_repo=%s, workflow_name=%s, run_id=%s, run_attempt=%s"
                    % (
                        key,
                        downstream_repo,
                        workflow_name,
                        run_id,
                        run_attempt,
                    )
                )
            elif current_record.state == CallbackState.COMPLETED:
                error_msg = "rejecting duplicate COMPLETED key=%s" % key
            elif current_record.state != CallbackState.IN_PROGRESS:
                error_msg = (
                    "rejecting abnormal state transition %s -> COMPLETED "
                    "key=%s, downstream_repo=%s, workflow_name=%s, run_id=%s, run_attempt=%s"
                    % (
                        current_record.state.value,
                        key,
                        downstream_repo,
                        workflow_name,
                        run_id,
                        run_attempt,
                    )
                )

        if error_msg:
            logger.warning(error_msg)
            raise AssertionError(error_msg)

        data: dict = {
            "state": state.value,
            "timestamp": timestamp,
        }
        if payload:
            data["payload"] = payload
        client.setex(key, config.oot_status_ttl, json.dumps(data))
        logger.info(
            "callback state set key=%s state=%s timestamp=%s",
            key,
            state.value,
            timestamp,
        )
    except RedisError:
        logger.exception("set_callback_state: redis is temporary outage or unreachable")
        raise
    except Exception:
        logger.exception("redis set_callback_state failed")
        raise


def _in_progress_member(
    delivery_id: str, downstream_repo: str, run_id: int, run_attempt: int
) -> str:
    """Build a ZSET member string from the state-key components."""
    return f"{delivery_id}:{downstream_repo}:{run_id}:{run_attempt}"


def _parse_in_progress_member(member: str) -> tuple[str, str, int, int]:
    """Parse a ZSET member string back into its components.

    The repo part may contain '/' (e.g. 'org/repo'), so we split from the right
    for the integer fields and from the left for delivery_id.
    """
    parts = member.split(":")
    if len(parts) < 4:
        raise ValueError(f"invalid in-progress member: {member!r}")
    # delivery_id is the first token, then repo is everything up to the last two tokens
    delivery_id = parts[0]
    run_attempt = int(parts[-1])
    run_id = int(parts[-2])
    downstream_repo = ":".join(parts[1:-2])
    return delivery_id, downstream_repo, run_id, run_attempt


def add_in_progress_tracker(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    run_id: int,
    run_attempt: int,
    client: redis_lib.Redis | None = None,
) -> None:
    """Add a job to the in-progress ZSET for zombie detection.

    The ZSET score is the expected timeout timestamp (now + zombie_timeout_seconds).
    Logs and ignores Redis errors — a missed tracker addition only affects zombie
    detection for this one job, not the core callback flow.
    """
    try:
        if client is None:
            client = create_client(config)
        member = _in_progress_member(delivery_id, downstream_repo, run_id, run_attempt)
        timeout_ts = time.time() + config.zombie_timeout_seconds
        client.zadd(_IN_PROGRESS_ZSET, {member: timeout_ts})
        # Auto-expire the ZSET key so it doesn't accumulate stale members forever.
        client.expire(_IN_PROGRESS_ZSET, config.zombie_timeout_seconds * 2)
        logger.info(
            "in_progress tracker added member=%s timeout_ts=%s", member, timeout_ts
        )
    except RedisError:
        logger.exception("failed to add in_progress tracker member=%s", member)


def remove_in_progress_tracker(
    config: RelayConfig,
    delivery_id: str,
    downstream_repo: str,
    run_id: int,
    run_attempt: int,
    client: redis_lib.Redis | None = None,
) -> None:
    """Remove a job from the in-progress ZSET after normal completion.

    Logs and ignores Redis errors — the ZSET member will eventually expire anyway.
    """
    try:
        if client is None:
            client = create_client(config)
        member = _in_progress_member(delivery_id, downstream_repo, run_id, run_attempt)
        client.zrem(_IN_PROGRESS_ZSET, member)
        logger.info("in_progress tracker removed member=%s", member)
    except RedisError:
        logger.exception("failed to remove in_progress tracker member=%s", member)


def scan_expired_in_progress(
    config: RelayConfig,
    client: redis_lib.Redis | None = None,
) -> list[dict]:
    """Scan the in-progress ZSET for members whose timeout has expired.

    For each expired member, fetch the corresponding state record.  Only return
    entries whose state is still IN_PROGRESS (a concurrent normal completion may
    have already resolved it).

    Returns a list of dicts with keys:
      delivery_id, downstream_repo, run_id, run_attempt, state_record
    The state_record includes the stored payload via ``state_record.payload``.
    """
    results: list[dict] = []
    try:
        if client is None:
            client = create_client(config)
        now = time.time()

        # Warn if the ZSET is growing unusually large — may indicate the sweeper
        # is not keeping up or has stopped running, allowing zombies to accumulate.
        zset_size = client.zcard(_IN_PROGRESS_ZSET)
        if zset_size > config.in_progress_warn_threshold:
            logger.warning(
                "in_progress ZSET cardinality %d exceeds threshold %d — "
                "sweeper may be falling behind or not running",
                zset_size,
                config.in_progress_warn_threshold,
            )

        expired_members = client.zrangebyscore(_IN_PROGRESS_ZSET, "-inf", now)
        if not expired_members:
            logger.info("no expired in_progress members found")
            return results

        logger.info("found %d expired in_progress members", len(expired_members))
        for member in expired_members:
            try:
                delivery_id, downstream_repo, run_id, run_attempt = (
                    _parse_in_progress_member(member)
                )
            except ValueError:
                logger.warning("malformed in_progress member, removing: %s", member)
                client.zrem(_IN_PROGRESS_ZSET, member)
                continue

            state_record = get_callback_state(
                config, delivery_id, downstream_repo, run_id, run_attempt, client
            )
            if state_record is None:
                # State record already expired/removed — clean up the stale ZSET entry.
                logger.info(
                    "state record missing for expired member=%s, removing tracker",
                    member,
                )
                client.zrem(_IN_PROGRESS_ZSET, member)
                continue

            if state_record.state != CallbackState.IN_PROGRESS:
                # Already resolved (race with normal completion) — just clean up.
                logger.info(
                    "state already %s for member=%s, removing tracker",
                    state_record.state.value,
                    member,
                )
                client.zrem(_IN_PROGRESS_ZSET, member)
                continue

            results.append(
                {
                    "delivery_id": delivery_id,
                    "downstream_repo": downstream_repo,
                    "run_id": run_id,
                    "run_attempt": run_attempt,
                    "state_record": state_record,
                }
            )
    except RedisError:
        logger.exception("scan_expired_in_progress failed")
    return results
