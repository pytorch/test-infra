from __future__ import annotations

import logging
import time

import utils.redis_helper as redis_helper
from utils.allowlist import AllowlistLevel, AllowlistMap, load_allowlist
from utils.config import RelayConfig
from utils.hud import forward_to_hud
from utils.misc import (
    CallbackState,
    CallbackStateRecord,
    DISPATCH_CHECK_RUN_ID,
    HTTPException,
)
from utils.redis_helper import check_rate_limit


logger = logging.getLogger(__name__)


def _safe_delta(
    start_ts: float | None, end_ts: float | None, label: str
) -> float | None:
    """Compute end-start, clamping tiny negatives to 0 and returning None
    whenever either endpoint is missing (e.g. Redis cache miss)."""
    if start_ts is None or end_ts is None:
        return None
    delta = round(end_ts - start_ts, 3)
    if delta < 0:
        logger.warning("negative %s computed, start=%s end=%s", label, start_ts, end_ts)
        return 0
    return delta


def _verify_access(config: RelayConfig, verified_repo: str) -> AllowlistMap | None:
    """Return the AllowlistMap when ``verified_repo`` is L2+, else None.

    Raises HTTPException(429) if the per-repo rate limit is exceeded.
    A ``None`` return signals the caller to silently ignore the request.
    """
    allowlist = load_allowlist(config)
    l2_repos, _ = allowlist.get_repos_at_or_above_level(AllowlistLevel.L2)
    if verified_repo not in l2_repos:
        logger.info(
            "verified_repo %s is not configured for L2+ features, ignoring result",
            verified_repo,
        )
        return None
    if not check_rate_limit(config, verified_repo):
        logger.warning(
            "rate limit exceeded for verified_repo=%s, rejecting request",
            verified_repo,
        )
        raise HTTPException(429, f"rate limit exceeded for {verified_repo}")
    return allowlist


def _parse_callback_body(body: dict) -> tuple[str, str, str, str, str]:
    """Return (delivery_id, status, check_run_id, job_name, run_id) from ``body``.

    check_run_id is set by GitHub Actions (job.check_run_id context) and
    cannot be tampered with, ensuring replay-attack detection integrity.

    Raises HTTPException(400) on any missing or mis-typed field.
    """
    try:
        delivery_id = body["delivery_id"]
        workflow_dict = body["workflow"]
        status = workflow_dict["status"]
        check_run_id = workflow_dict["check_run_id"]  # Required
        job_name = workflow_dict["job_name"]  # Required for HUD grouping
        run_id = workflow_dict["run_id"]  # Required for HUD grouping
    except (KeyError, TypeError) as exc:
        logger.warning("missing required field in callback body: %s", exc)
        raise HTTPException(
            400, f"callback body missing required field: {exc}"
        ) from exc
    return delivery_id, status, check_run_id, job_name, run_id


def _update_state_and_compute_metrics(
    config: RelayConfig,
    delivery_id: str,
    verified_repo: str,
    check_run_id: str,
    job_name: str,
    run_id: str,
    status: str,
    dispatch_record: CallbackStateRecord,
    job_record: CallbackStateRecord | None,
) -> dict:
    """Persist the new job state to Redis and return CI timing metrics.

    Writes IN_PROGRESS or COMPLETED state (with the current timestamp), then
    reads back the stored record to compute:
    - ``queue_time``:     dispatch → in_progress  (set on "in_progress" callbacks)
    - ``execution_time``: in_progress → completed  (set on "completed" callbacks)

    Both metrics default to None when the required prior state is unavailable
    (e.g. Redis cache miss or rerun without matching prior record).
    """
    ci_metrics: dict = {"queue_time": None, "execution_time": None}
    current_timestamp = time.time()

    if status == "in_progress":
        if not redis_helper.set_callback_state(
            config,
            delivery_id,
            verified_repo,
            check_run_id,
            CallbackState.IN_PROGRESS,
            current_timestamp,
            job_name,
            run_id,
        ):
            raise HTTPException(
                400,
                f"callback rejected: invalid state transition delivery_id={delivery_id} status={status}",
            )
        updated_job_record = redis_helper.get_callback_state(
            config, delivery_id, verified_repo, check_run_id
        )
        if updated_job_record is not None:
            ci_metrics["queue_time"] = _safe_delta(
                dispatch_record.timestamp,
                updated_job_record.timestamp,
                "queue_time",
            )

    elif status == "completed":
        if not redis_helper.set_callback_state(
            config,
            delivery_id,
            verified_repo,
            check_run_id,
            CallbackState.COMPLETED,
            current_timestamp,
            job_name,
            run_id,
        ):
            raise HTTPException(
                400,
                f"callback rejected: invalid state transition delivery_id={delivery_id} status={status}",
            )
        updated_job_record = redis_helper.get_callback_state(
            config, delivery_id, verified_repo, check_run_id
        )
        if updated_job_record is not None:
            ci_metrics["execution_time"] = _safe_delta(
                job_record.timestamp, updated_job_record.timestamp, "execution_time"
            )

    else:
        raise HTTPException(400, f"unknown callback status: {status!r}")

    return ci_metrics


def handle(config: RelayConfig, body: dict, verified_repo: str) -> dict:
    """Forward a downstream callback to HUD.

    ``body`` is the downstream self-report, passed through to HUD verbatim.
    It carries the original dispatch envelope (``delivery_id``, ``payload``)
    and a sibling ``workflow`` dict with status/conclusion/name/url.

    ``verified_repo`` is the OIDC-authenticated downstream repository — used
    for allowlist / timing lookups, and surfaced to HUD as ``verified_repo``
    so HUD can trust it over anything self-reported in the body.

    State machine ensures:
    - Callbacks without prior dispatch are rejected
    - Timestamps (started_at, completed_at) are recorded once only
    - Duplicate callbacks are handled gracefully
    - State transitions follow valid lifecycle paths
    """
    allowlist = _verify_access(config, verified_repo)
    if allowlist is None:
        return {"ok": True, "status": "ignored"}

    delivery_id, status, check_run_id, job_name, run_id = _parse_callback_body(body)

    # Get dispatch state record (proves valid webhook, provides dispatch timestamp)
    dispatch_record = redis_helper.get_callback_state(
        config, delivery_id, verified_repo, DISPATCH_CHECK_RUN_ID
    )
    if not dispatch_record:
        logger.warning(
            "no dispatch record found for delivery_id=%s, verified_repo=%s; rejecting callback",
            delivery_id,
            verified_repo,
        )
        raise HTTPException(400, "callback rejected: no matching dispatch record")
    # Get job-level state record
    job_record = redis_helper.get_callback_state(
        config, delivery_id, verified_repo, check_run_id
    )

    ci_metrics = _update_state_and_compute_metrics(
        config,
        delivery_id,
        verified_repo,
        check_run_id,
        job_name,
        run_id,
        status,
        dispatch_record,
        job_record,
    )

    repo_level = allowlist.get_repo_level(verified_repo)
    if repo_level is None:
        logger.error(
            "verified_repo %s not found in allowlist after passing L2+ check",
            verified_repo,
        )
        raise HTTPException(
            500, f"internal error: repo level lookup failed for {verified_repo}"
        )

    trusted = {
        "ci_metrics": ci_metrics,
        "verified_repo": verified_repo,
        "downstream_repo_level": repo_level.value,
    }
    # downstream's payload is untrusted — provide it under the "callback_payload"
    # key so HUD receives it under the expected untrusted namespace.
    untrusted = {"callback_payload": body}

    try:
        forward_to_hud(config, trusted, untrusted)
    except HTTPException as exc:
        if 400 <= exc.status_code < 500:
            raise
        logger.error("HUD internal error (HTTP %d): %s", exc.status_code, exc.detail)
        return {
            "ok": True,
            "status": status,
            "warning": "HUD update failed but CI run is valid",
        }
    return {"ok": True, "status": status}
