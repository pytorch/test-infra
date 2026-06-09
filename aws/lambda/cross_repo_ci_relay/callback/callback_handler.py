from __future__ import annotations

import logging
import time

import utils.redis_helper as redis_helper
from redis.exceptions import RedisError
from utils import gh_helper
from utils.allowlist import AllowlistLevel, AllowlistMap, load_allowlist
from utils.config import RelayConfig
from utils.hud import forward_to_hud
from utils.misc import (
    CallbackState,
    CallbackStateRecord,
    DISPATCH_CHECK_RUN_ID,
    extract_pr_labels,
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


def _verify_access(
    config: RelayConfig, verified_repo: str
) -> tuple[AllowlistMap, AllowlistLevel] | None:
    """Return (AllowlistMap, repo_level) when ``verified_repo`` is L2+, else None.

    Raises HTTPException(429) if the per-repo rate limit is exceeded.
    A ``None`` return signals the caller to silently ignore the request.
    """
    allowlist = load_allowlist(config)
    repo_level = allowlist.get_repo_level(verified_repo)
    if repo_level is None or repo_level.value < AllowlistLevel.L2.value:
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
    return allowlist, repo_level


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
        logger.warning(f"missing required field in callback body: {exc}")
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
    if status not in ("in_progress", "completed"):
        raise HTTPException(400, f"unknown callback status: {status!r}")

    ci_metrics: dict = {"queue_time": None, "execution_time": None}
    current_timestamp = time.time()
    state = (
        CallbackState.IN_PROGRESS
        if status == "in_progress"
        else CallbackState.COMPLETED
    )

    try:
        redis_helper.set_callback_state(
            config,
            delivery_id,
            verified_repo,
            check_run_id,
            state,
            current_timestamp,
            job_name,
            run_id,
        )
    except RedisError:
        raise HTTPException(
            503, "redis temporary outage: failed to persist callback state"
        )
    except AssertionError as e:
        msg = (
            "callback rejected: invalid state transition delivery_id=%s repo=%s status=%s"
            % (delivery_id, verified_repo, status)
        )
        raise HTTPException(400, msg) from e
    except Exception:
        raise

    updated_job_record = redis_helper.get_callback_state(
        config, delivery_id, verified_repo, check_run_id
    )
    if updated_job_record is None:
        return ci_metrics

    if state == CallbackState.IN_PROGRESS:
        ci_metrics["queue_time"] = _safe_delta(
            dispatch_record.timestamp,
            updated_job_record.timestamp,
            "queue_time",
        )
    else:
        if job_record is not None:
            ci_metrics["execution_time"] = _safe_delta(
                job_record.timestamp, updated_job_record.timestamp, "execution_time"
            )

    return ci_metrics


def _update_upstream_check_run(
    *,
    config: RelayConfig,
    verified_repo: str,
    delivery_id: str,
    status: str,
    check_run_id: str,
    run_id: str,
    body: dict,
    needs_check_run: bool = True,
) -> None:
    """Cache the downstream job state and update the upstream check run.

    Called for L3+ repos before HUD forwarding so that a HUD error cannot
    prevent the upstream PR check from reflecting the correct workflow status.

    On the first in_progress callback the upstream check run is created with
    the real workflow name and link.  Subsequent callbacks update the existing
    check run.  If head_sha is absent the check run cannot be created.
    """
    payload_field = body.get("payload") or {}
    pr_field = payload_field.get("pull_request") or {}
    head_sha = (pr_field.get("head") or {}).get("sha", "")

    workflow = body.get("workflow") or {}
    conclusion = workflow.get("conclusion")
    workflow_name = workflow.get("name", "")

    details_url = f"https://github.com/{verified_repo}/actions/runs/{run_id}"

    redis_helper.set_dispatch_workflow(
        config,
        head_sha,
        verified_repo,
        status,
        check_run_id,
        conclusion,
        details_url,
        run_id=run_id,
        workflow_name=workflow_name,
    )

    if not needs_check_run:
        return

    if not head_sha:
        logger.warning(
            "no head_sha; cannot create upstream check run delivery_id=%s repo=%s",
            delivery_id,
            verified_repo,
        )
        return

    output = gh_helper.build_check_run_output(workflow_name, details_url, verified_repo)

    try:
        upstream_token = gh_helper.get_repo_access_token(
            config.github_app_id,
            config.github_app_private_key,
            config.upstream_repo,
        )
        # Always create a new check run. GitHub shows only the latest check run
        # with the same name on a commit, so this naturally replaces any previous one
        cr_id = gh_helper.create_check_run(
            token=upstream_token,
            repo_full_name=config.upstream_repo,
            name=gh_helper.check_run_name(verified_repo, workflow_name),
            head_sha=head_sha,
            status=status,
            conclusion=conclusion,
            details_url=details_url,
            external_id=run_id,
            output=output,
        )
        logger.info(
            "upstream check run created delivery_id=%s repo=%s status=%s cr_id=%s",
            delivery_id,
            verified_repo,
            status,
            cr_id,
        )
    except Exception:
        logger.exception(
            "failed to manage upstream check run delivery_id=%s repo=%s",
            delivery_id,
            verified_repo,
        )


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
    result = _verify_access(config, verified_repo)
    if result is None:
        return {"ok": True, "status": "ignored"}
    allowlist, repo_level = result

    delivery_id, status, check_run_id, job_name, run_id = _parse_callback_body(body)

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

    # L3+: update the upstream check run first so a HUD error cannot block it.
    if repo_level.value >= AllowlistLevel.L3.value:
        needs_cr = allowlist.needs_check_run(verified_repo, extract_pr_labels(body))
        if not needs_cr and repo_level == AllowlistLevel.L3:
            # The downstream's echoed payload labels may not reflect the PR's
            # current state (e.g. on reopen). Fall back to the per-commit flag
            # recorded at dispatch / label time for this (head_sha, repo).
            pr_field = (body.get("payload") or {}).get("pull_request") or {}
            head_sha = (pr_field.get("head") or {}).get("sha", "")
            if head_sha:
                needs_cr = redis_helper.is_check_run_wanted(
                    config, head_sha, verified_repo
                )
        _update_upstream_check_run(
            config=config,
            verified_repo=verified_repo,
            delivery_id=delivery_id,
            status=status,
            check_run_id=check_run_id,
            run_id=run_id,
            body=body,
            needs_check_run=needs_cr,
        )

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

    trusted = {
        "ci_metrics": ci_metrics,
        "verified_repo": verified_repo,
        "downstream_repo_level": repo_level.value,
    }
    # downstream's payload is untrusted — provide it under the "callback_payload"
    # key so HUD receives it under the expected untrusted namespace.
    untrusted = {"callback_payload": body}

    forward_to_hud(config, trusted, untrusted)
    return {"ok": True, "status": status}
