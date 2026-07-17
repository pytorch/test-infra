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
    DISPATCH_RUN_ATTEMPT,
    DISPATCH_RUN_ID,
    extract_pr_labels,
    HTTPException,
)
from utils.redis_helper import check_rate_limit


logger = logging.getLogger(__name__)

_NIGHTLY_EVENT_TYPES = frozenset({"nightly", "periodic"})


def _build_trusted(
    verified_repo: str,
    repo_level: AllowlistLevel,
    ci_metrics: dict | None = None,
) -> dict:
    """Build the trusted payload block forwarded to HUD."""
    if ci_metrics is None:
        ci_metrics = {"queue_time": None, "execution_time": None}
    return {
        "ci_metrics": ci_metrics,
        "verified_repo": verified_repo,
        "downstream_repo_level": repo_level.value,
    }


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


def _parse_callback_body(body: dict) -> tuple[str, str, int, int, str, str | None]:
    """Return (delivery_id, status, run_id, run_attempt, workflow_name, job_name).

    run_id and run_attempt identify a workflow run execution.
    job_name (``github.job``) disambiguates multiple jobs within the same run.
    run_attempt defaults to 1 when not present in the callback body.

    Raises HTTPException(400) on any missing or mis-typed field.
    """
    try:
        delivery_id = body["delivery_id"]
        workflow_dict = body["workflow"]
        status = workflow_dict["status"]
        run_id = int(workflow_dict["run_id"])
        run_attempt = int(workflow_dict.get("run_attempt", 1))
        workflow_name = workflow_dict["name"]
        job_name = workflow_dict.get("job_name")
    except (KeyError, TypeError) as exc:
        logger.warning(f"missing required field in callback body: {exc}")
        raise HTTPException(
            400, f"callback body missing required field: {exc}"
        ) from exc
    return delivery_id, status, run_id, run_attempt, workflow_name, job_name


def _update_state_and_compute_metrics(
    config: RelayConfig,
    delivery_id: str,
    verified_repo: str,
    run_id: int,
    run_attempt: int,
    workflow_name: str,
    status: str,
    dispatch_record: CallbackStateRecord,
    workflow_record: CallbackStateRecord | None,
    payload: dict | None = None,
    job_name: str | None = None,
) -> dict:
    """Persist the new workflow state to Redis and return CI timing metrics.

    Writes IN_PROGRESS or COMPLETED state (with the current timestamp), then
    reads back the stored record to compute:
    - ``queue_time``:     dispatch → in_progress  (set on "in_progress" callbacks)
    - ``execution_time``: in_progress → completed  (set on "completed" callbacks)

    Both metrics default to None when the required prior state is unavailable
    (e.g. Redis cache miss or rerun without matching prior record).

    For a re-run, ``queue_time`` is measured against the original dispatch (the
    re-run reuses its delivery_id), so it is not a meaningful queue interval —
    HUD distinguishes re-runs via ``workflow.run_attempt`` in the forwarded body.
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
            run_id,
            run_attempt,
            state,
            current_timestamp,
            workflow_name,
            payload=payload,
            job_name=job_name,
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

    updated_workflow_record = redis_helper.get_callback_state(
        config, delivery_id, verified_repo, run_id, run_attempt, job_name=job_name
    )
    if updated_workflow_record is None:
        return ci_metrics

    if state == CallbackState.IN_PROGRESS:
        ci_metrics["queue_time"] = _safe_delta(
            dispatch_record.timestamp,
            updated_workflow_record.timestamp,
            "queue_time",
        )
    else:
        if workflow_record is not None:
            ci_metrics["execution_time"] = _safe_delta(
                workflow_record.timestamp,
                updated_workflow_record.timestamp,
                "execution_time",
            )

    return ci_metrics


def _create_upstream_check_run(
    *,
    config: RelayConfig,
    verified_repo: str,
    delivery_id: str,
    status: str,
    conclusion: str | None,
    run_id: int,
    head_sha: str,
    workflow_name: str,
    job_name: str | None,
    details_url: str,
) -> None:
    """Create a new upstream check run mirroring the downstream job's status.

    Called for L3+ repos (only when a check run is wanted and head_sha is known)
    before HUD forwarding, so a HUD error cannot block the upstream PR check.

    Every callback always *creates* a new check run (never edits an existing
    one): GitHub only surfaces the latest check run of a given name on a commit,
    so each new one supersedes the previous, keeping the logic stateless.
    Best-effort: a GitHub failure must not fail the callback.
    """
    output = gh_helper.build_check_run_output(
        status, conclusion, details_url, verified_repo
    )
    try:
        upstream_token = gh_helper.get_repo_access_token(
            config.github_app_id,
            config.github_app_private_key,
            config.upstream_repo,
        )
        cr_id = gh_helper.create_check_run(
            token=upstream_token,
            repo_full_name=config.upstream_repo,
            name=gh_helper.check_run_name(verified_repo, workflow_name, job_name),
            head_sha=head_sha,
            status=status,
            conclusion=conclusion,
            details_url=details_url,
            # Store the downstream run_id so a check-run rerequest can re-run
            # the failed jobs of that workflow run.
            external_id=str(run_id),
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
            "failed to create upstream check run delivery_id=%s repo=%s",
            delivery_id,
            verified_repo,
        )


def _handle_nightly_callback(
    config: RelayConfig,
    body: dict,
    verified_repo: str,
    repo_level: AllowlistLevel,
) -> dict:
    """Handle a nightly/periodic self-report callback.

    Unlike PR/push callbacks, nightly/periodic have no prior dispatch record
    and no state machine.  The downstream repo self-triggers via cron, runs CI
    against a pytorch/pytorch SHA (from the nightly branch or main), and
    reports the final result in a single callback.

    No Redis writes, no zombie tracking, no upstream check runs.
    """
    delivery_id, status, *_ = _parse_callback_body(body)

    if status != "completed":
        raise HTTPException(
            400,
            f"nightly/periodic callbacks must have status 'completed', got {status!r}",
        )

    trusted = _build_trusted(verified_repo, repo_level)
    untrusted = {"callback_payload": body}

    forward_to_hud(config, trusted, untrusted)
    logger.info(
        "nightly callback forwarded delivery_id=%s repo=%s event_type=%s",
        delivery_id,
        verified_repo,
        body.get("event_type", "unknown"),
    )
    return {"ok": True, "status": status}


def handle(config: RelayConfig, body: dict, verified_repo: str) -> dict:
    """Forward a downstream callback to HUD.

    ``body`` is the downstream self-report, passed through to HUD verbatim.
    It carries the original dispatch envelope (``delivery_id``, ``payload``)
    and a sibling ``workflow`` dict with status/conclusion/name/url.

    ``verified_repo`` is the OIDC-authenticated downstream repository — used
    for allowlist / timing lookups, and surfaced to HUD as ``verified_repo``
    so HUD can trust it over anything self-reported in the body.

    For nightly/periodic event types, the state machine is bypassed entirely
    and the result is forwarded to HUD in a single callback (no Redis, no
    in_progress step, no zombie tracking).

    For PR/push events, the state machine ensures:
    - Callbacks without prior dispatch are rejected
    - Timestamps (started_at, completed_at) are recorded once only
    - Duplicate callbacks are handled gracefully
    - State transitions follow valid lifecycle paths
    """
    result = _verify_access(config, verified_repo)
    if result is None:
        return {"ok": True, "status": "ignored"}
    allowlist, repo_level = result

    # NOTE: event_type is untrusted (comes from the callback body, not from the
    # OIDC token). It only selects among safe code paths — the nightly path
    # never grants additional capability (no check runs, no Redis writes, no
    # state machine bypass for PR events).  HUD treats nightly rows as
    # informational, attributed to the OIDC-verified repo.
    event_type = body.get("event_type", "")
    if event_type in _NIGHTLY_EVENT_TYPES:
        return _handle_nightly_callback(config, body, verified_repo, repo_level)

    delivery_id, status, run_id, run_attempt, workflow_name, job_name = (
        _parse_callback_body(body)
    )

    dispatch_record = redis_helper.get_callback_state(
        config, delivery_id, verified_repo, DISPATCH_RUN_ID, DISPATCH_RUN_ATTEMPT
    )
    if not dispatch_record:
        logger.warning(
            "no dispatch record found for delivery_id=%s, verified_repo=%s; rejecting callback",
            delivery_id,
            verified_repo,
        )
        raise HTTPException(400, "callback rejected: no matching dispatch record")

    workflow_record = redis_helper.get_callback_state(
        config, delivery_id, verified_repo, run_id, run_attempt, job_name=job_name
    )

    payload = None
    if status == "in_progress":
        payload = {
            "trusted": _build_trusted(verified_repo, repo_level),
            "untrusted": {"callback_payload": body},
        }

    ci_metrics = _update_state_and_compute_metrics(
        config,
        delivery_id,
        verified_repo,
        run_id,
        run_attempt,
        workflow_name,
        status,
        dispatch_record,
        workflow_record,
        payload=payload,
        job_name=job_name,
    )

    # L3+: cache the job and create its upstream check run. Runs after state
    # validation (above) but before HUD forwarding, so a HUD error cannot block
    # the PR check. Without a head_sha there is neither a check run to create nor
    # a cache entry the label handler could ever look up.
    if repo_level.value >= AllowlistLevel.L3.value:
        pr_field = (body.get("payload") or {}).get("pull_request") or {}
        head_sha = (pr_field.get("head") or {}).get("sha", "")
        if head_sha:
            conclusion = (body.get("workflow") or {}).get("conclusion")
            details_url = f"https://github.com/{verified_repo}/actions/runs/{run_id}"

            # Always cache the job so a later label event can backfill its check
            # run, even when we are not creating one now.
            redis_helper.set_dispatch_job(
                config,
                head_sha,
                verified_repo,
                status,
                conclusion,
                details_url,
                run_id=str(run_id),
                workflow_name=workflow_name,
                job_name=job_name,
            )

            needs_cr = allowlist.needs_check_run(verified_repo, extract_pr_labels(body))
            if not needs_cr and repo_level == AllowlistLevel.L3:
                # The downstream's echoed payload labels may not reflect the PR's
                # current state (e.g. on reopen). Fall back to the per-commit flag
                # recorded at dispatch / label time for this (head_sha, repo).
                needs_cr = redis_helper.is_check_run_wanted(
                    config, head_sha, verified_repo
                )

            if needs_cr:
                _create_upstream_check_run(
                    config=config,
                    verified_repo=verified_repo,
                    delivery_id=delivery_id,
                    status=status,
                    conclusion=conclusion,
                    run_id=run_id,
                    head_sha=head_sha,
                    workflow_name=workflow_name,
                    job_name=job_name,
                    details_url=details_url,
                )

    if status == "in_progress":
        redis_helper.add_in_progress_tracker(
            config, delivery_id, verified_repo, run_id, run_attempt, job_name=job_name
        )
    elif status == "completed":
        redis_helper.remove_in_progress_tracker(
            config, delivery_id, verified_repo, run_id, run_attempt, job_name=job_name
        )

    trusted = _build_trusted(verified_repo, repo_level, ci_metrics)
    # downstream's payload is untrusted — provide it under the "callback_payload"
    # key so HUD receives it under the expected untrusted namespace.
    untrusted = {"callback_payload": body}

    forward_to_hud(config, trusted, untrusted)
    return {"ok": True, "status": status}
