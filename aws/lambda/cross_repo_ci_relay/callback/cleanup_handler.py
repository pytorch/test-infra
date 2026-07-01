"""Zombie-job cleanup handler.

Triggered by EventBridge cron events.  Scans the Redis in-progress ZSET for
jobs whose timeout has expired, marks them as timed_out in HUD, and cleans up
the Redis records.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import as_completed, ThreadPoolExecutor

import utils.redis_helper as redis_helper
from redis.exceptions import RedisError
from utils import gh_helper
from utils.allowlist import AllowlistLevel, load_allowlist
from utils.config import RelayConfig
from utils.hud import forward_to_hud
from utils.misc import CallbackState, extract_pr_labels


logger = logging.getLogger(__name__)


def _build_timeout_payload(zombie: dict, completed_at: str) -> tuple[dict, dict]:
    """Build trusted and untrusted HUD payloads for a timed-out job.

    Starts from the stored HUD envelope that was captured at IN_PROGRESS time,
    then updates ci_metrics and workflow status/conclusion for the timeout.
    """
    state_record = zombie["state_record"]
    stored = state_record.payload
    stored_trusted = dict(stored["trusted"])
    stored_untrusted = dict(stored["untrusted"])

    # ci_metrics: execution_time from in_progress → now
    execution_time = round(time.time() - state_record.timestamp, 3)
    if execution_time < 0:
        execution_time = 0

    stored_trusted["ci_metrics"] = {
        "queue_time": None,
        "execution_time": execution_time,
    }

    # Update the stored workflow with timeout conclusion

    workflow = stored_untrusted["callback_payload"]["workflow"]
    workflow["status"] = "completed"
    workflow["conclusion"] = "timed_out"
    workflow["completed_at"] = completed_at

    return stored_trusted, stored_untrusted


def _finalize_timed_out_check_run(config: RelayConfig, zombie: dict) -> None:
    """Create a completed/timed_out upstream check run for an L3+ zombie.

    A zombie's downstream stopped reporting, so its upstream check run is left
    in_progress forever. The HUD/Redis updates don't touch GitHub, so for L3/L4
    repos we mirror the live callback's check-run creation here — using the body
    captured at IN_PROGRESS time — but with a terminal timed_out conclusion.
    Best-effort: a GitHub failure must not block the rest of cleanup.
    """
    payload = zombie["state_record"].payload or {}
    trusted = payload.get("trusted") or {}
    verified_repo = trusted.get("verified_repo", "")
    body = (payload.get("untrusted") or {}).get("callback_payload") or {}
    if not verified_repo or not body:
        return

    # Cheap pre-check from the level captured at in_progress time: only L3+ repos
    # ever get an upstream check run, so skip the allowlist/GitHub work otherwise.
    if trusted.get("downstream_repo_level", "") < AllowlistLevel.L3.value:
        return

    allowlist = load_allowlist(config)
    level = allowlist.get_repo_level(verified_repo)
    if level is None or level.value < AllowlistLevel.L3.value:
        return

    pr_field = (body.get("payload") or {}).get("pull_request") or {}
    head_sha = (pr_field.get("head") or {}).get("sha", "")
    if not head_sha:
        return

    # Only finalize repos that actually had a check run at in_progress time —
    # same gating as the live callback path.
    needs_cr = allowlist.needs_check_run(verified_repo, extract_pr_labels(body))
    if not needs_cr and level == AllowlistLevel.L3:
        needs_cr = redis_helper.is_check_run_wanted(config, head_sha, verified_repo)
    if not needs_cr:
        return

    workflow = body.get("workflow") or {}
    workflow_name = workflow.get("name", "")
    job_name = workflow.get("job_name")
    job_id = workflow.get("job_id")
    run_id = str(workflow.get("run_id"))
    details_url = f"https://github.com/{verified_repo}/actions/runs/{run_id}"
    output = gh_helper.build_check_run_output(
        "completed", "timed_out", details_url, verified_repo
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
            status="completed",
            conclusion="timed_out",
            details_url=details_url,
            external_id=str(job_id),
            output=output,
        )
        logger.info(
            "zombie check run finalized timed_out repo=%s run_id=%s cr_id=%s",
            verified_repo,
            run_id,
            cr_id,
        )
    except Exception:
        logger.exception(
            "zombie check run finalize failed repo=%s run_id=%s",
            verified_repo,
            run_id,
        )


def _cleanup_one(
    *,
    config: RelayConfig,
    zombie: dict,
    completed_at: str,
) -> dict:
    """Process a single zombie job: forward timeout to HUD, update Redis,
    and remove the in-progress tracker.

    Returns a dict with ``ok`` indicating whether the zombie was cleaned
    successfully (HUD forward succeeded).
    """
    _finalize_timed_out_check_run(config, zombie)

    delivery_id = zombie["delivery_id"]
    repo = zombie["downstream_repo"]
    run_id = zombie["run_id"]
    run_attempt = zombie["run_attempt"]
    job_name = zombie.get("job_name")
    hud_ok = True

    try:
        trusted, untrusted = _build_timeout_payload(zombie, completed_at)
        forward_to_hud(config, trusted, untrusted)
        logger.info(
            "zombie HUD forward succeeded repo=%s run_id=%s run_attempt=%s job_name=%s",
            repo,
            run_id,
            run_attempt,
            job_name,
        )
    except Exception:
        logger.exception(
            "zombie HUD forward failed repo=%s run_id=%s run_attempt=%s job_name=%s",
            repo,
            run_id,
            run_attempt,
            job_name,
        )
        hud_ok = False

    if hud_ok:
        try:
            redis_helper.set_callback_state(
                config,
                delivery_id,
                repo,
                run_id,
                run_attempt,
                CallbackState.COMPLETED,
                time.time(),
                job_name=job_name,
            )
        except (AssertionError, RedisError):
            logger.warning(
                "zombie state transition failed (may already be resolved) "
                "delivery_id=%s repo=%s run_id=%s run_attempt=%s job_name=%s",
                delivery_id,
                repo,
                run_id,
                run_attempt,
                job_name,
            )
        redis_helper.remove_in_progress_tracker(
            config, delivery_id, repo, run_id, run_attempt, job_name=job_name
        )

    return {"ok": hud_ok}


def handle(config: RelayConfig) -> dict:
    """Scan for zombie jobs and clean them up in parallel.

    Returns a summary dict with counts of cleaned and errored zombies.
    """
    zombies = redis_helper.scan_expired_in_progress(config)
    results = {"cleaned": 0, "errors": 0}

    if not zombies:
        logger.info("zombie scan: no expired jobs found")
        return {"ok": True, **results}

    logger.info("zombie scan: found %d expired job(s)", len(zombies))
    completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    with ThreadPoolExecutor(max_workers=config.max_cleanup_workers) as pool:
        future_to_zombie = {
            pool.submit(
                _cleanup_one,
                config=config,
                zombie=zombie,
                completed_at=completed_at,
            ): zombie
            for zombie in zombies
        }

        for future in as_completed(future_to_zombie):
            zombie = future_to_zombie[future]
            try:
                result = future.result()
                if result["ok"]:
                    results["cleaned"] += 1
                else:
                    results["errors"] += 1
            except Exception:
                logger.exception(
                    "zombie cleanup unexpected failure repo=%s run_id=%s",
                    zombie.get("downstream_repo"),
                    zombie.get("run_id"),
                )
                results["errors"] += 1

    return {"ok": True, **results}
