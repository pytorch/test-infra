from __future__ import annotations

import json
import logging
import time
from concurrent.futures import as_completed, ThreadPoolExecutor

from utils import gh_helper, redis_helper
from utils.allowlist import AllowlistLevel, load_allowlist
from utils.config import RelayConfig
from utils.misc import (
    CallbackState,
    DISPATCH_RUN_ATTEMPT,
    DISPATCH_RUN_ID,
    EventDispatchPayload,
    extract_pr_labels,
    HTTPException,
)


logger = logging.getLogger(__name__)
_PULL_REQUEST_ALLOW_ACTIONS = frozenset({"opened", "reopened", "synchronize", "closed"})


def _dispatch_one(
    *,
    config: RelayConfig,
    downstream_repo: str,
    event_type: str,
    client_payload: EventDispatchPayload,
    needs_check_run: bool = False,
) -> None:
    installation_token = gh_helper.get_repo_access_token(
        config.github_app_id,
        config.github_app_private_key,
        downstream_repo,
    )
    gh_helper.create_repository_dispatch(
        token=installation_token,
        repo_full_name=downstream_repo,
        event_type=event_type,
        client_payload=client_payload,
    )

    # Set dispatch state with timestamp to prove valid webhook occurred.
    # Keyed by delivery_id + repo + run_id + run_attempt.
    # Uses DISPATCH_RUN_ID/DISPATCH_RUN_ATTEMPT sentinels for repo-level dispatch.
    # Timestamp is used for queue_time calculation (dispatch → in_progress).
    redis_helper.set_callback_state(
        config,
        client_payload["delivery_id"],
        downstream_repo,
        DISPATCH_RUN_ID,
        DISPATCH_RUN_ATTEMPT,
        CallbackState.DISPATCHED,
        time.time(),
    )

    if needs_check_run:
        # This repo should get an upstream check run for this commit (L4 always,
        # or L3 with the ciflow/crcr label already on the PR). Record a per-commit
        # flag so the callback creates it even when the downstream echoes back a
        # dispatch payload whose labels don't reflect the PR's current state
        # (e.g. on reopen, where no new `labeled` event fires to set this flag).
        head_sha = (
            ((client_payload.get("payload") or {}).get("pull_request") or {})
            .get("head", {})
            .get("sha", "")
        )
        if head_sha:
            redis_helper.mark_check_run_wanted(config, head_sha, downstream_repo)


def _dispatch_to_allowlist(
    *,
    config: RelayConfig,
    client_payload: EventDispatchPayload,
) -> tuple[list[dict], list[dict]]:
    event_type = client_payload["event_type"]
    # Check allowlist first — avoid unnecessary token fetch if there's nothing to dispatch
    allowlist = load_allowlist(config)
    backends, _ = allowlist.get_repos_at_or_above_level(AllowlistLevel.L1)
    if not backends:
        logger.info("allowlist is empty, nothing to dispatch")
        return [], []

    targets = sorted(backends)

    # Labels from the dispatch payload, used to record a per-commit check-run
    # trigger for L3 repos whose ciflow/crcr label is already on the PR (so the
    # callback can create the check run regardless of the downstream's echo).
    pr_labels = extract_pr_labels(client_payload)

    dispatched: list[dict] = []
    failed: list[dict] = []
    # Dispatch is I/O bound on GitHub API calls, so cap workers by the number
    # of targets and the configured maximum.
    max_workers = min(len(targets), config.max_dispatch_workers)
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_repo = {
            pool.submit(
                _dispatch_one,
                config=config,
                downstream_repo=downstream_repo,
                event_type=event_type,
                client_payload=client_payload,
                needs_check_run=allowlist.needs_check_run(downstream_repo, pr_labels),
            ): downstream_repo
            for downstream_repo in targets
        }

        for future in as_completed(future_to_repo):
            downstream_repo = future_to_repo[future]
            try:
                future.result()
                logger.info(
                    "dispatch succeeded event_type=%s repo=%s",
                    event_type,
                    downstream_repo,
                )
                dispatched.append({"repo": downstream_repo})
            except Exception as e:
                logger.exception(
                    "dispatch failed event_type=%s repo=%s",
                    event_type,
                    downstream_repo,
                )
                error_message = str(e)
                failed.append(
                    {
                        "repo": downstream_repo,
                        "error": f"GitHub dispatch failed: {error_message}",
                    }
                )
    return dispatched, failed


def _handle_pr_labeled(config: RelayConfig, payload: dict) -> dict:
    """Handle pull_request.labeled for ciflow/crcr/* labels.

    - No job info yet: mark the check run as wanted so the callback creates it
      when it fires (handles label-added-before-callback and label-before-dispatch).
    - in_progress job: create in_progress check run with workflow name and link.
    - completed job: create completed check run directly.
    """
    label_name = (payload.get("label") or {}).get("name", "")
    device = label_name.removeprefix("ciflow/crcr/")

    allowlist = load_allowlist(config)
    l3_repos, _ = allowlist.get_repos_for_device(device)
    if not l3_repos:
        return {"ok": True, "created_check_runs": []}

    pr = payload.get("pull_request") or {}
    pr_number = str(pr.get("number", ""))
    head_sha = (pr.get("head") or {}).get("sha", "")
    if not pr_number or not head_sha:
        return {"ignored": True, "reason": "missing pr context"}

    created: list[str] = []

    # Minted lazily on the first repo that needs a check run, then reused: the
    # token is always for config.upstream_repo, so it's shared across all repos
    # under this device. A mint failure fails identically for every repo, so it
    # is left to propagate rather than retried per-iteration.
    upstream_token: str | None = None

    for downstream_repo in l3_repos:
        redis_helper.mark_check_run_wanted(config, head_sha, downstream_repo)
        # Every job that has already reported gets its own backfilled check run,
        # so a multi-job / matrix workflow is not collapsed to a single job.
        jobs = redis_helper.get_dispatch_jobs(config, head_sha, downstream_repo)
        if not jobs:
            logger.info(
                "l3_labeled: no job info for repo=%s; check run marked wanted for callback",
                downstream_repo,
            )
            continue

        if upstream_token is None:
            upstream_token = gh_helper.get_repo_access_token(
                config.github_app_id,
                config.github_app_private_key,
                config.upstream_repo,
            )

        for job_info in jobs:
            job_status = job_info.get("status")
            if job_status not in ("in_progress", "completed"):
                continue
            job_name = job_info.get("job_name")  # disambiguates jobs in one run
            try:
                job_conclusion = job_info.get("conclusion")
                workflow_name = job_info.get("workflow_name")
                run_id = job_info.get("run_id")  # stored on the CR for re-runs
                details_url = job_info.get("job_url")  # full URL for the link

                gh_helper.create_check_run(
                    token=upstream_token,
                    repo_full_name=config.upstream_repo,
                    name=gh_helper.check_run_name(
                        downstream_repo, workflow_name, job_name
                    ),
                    head_sha=head_sha,
                    status=job_status,
                    conclusion=(job_conclusion if job_status == "completed" else None),
                    details_url=details_url,
                    external_id=str(run_id),
                    output=gh_helper.build_check_run_output(
                        job_status, job_conclusion, details_url, downstream_repo
                    ),
                )
                created.append(f"{downstream_repo}/{job_name}")
                logger.info(
                    "l3_labeled: check run created repo=%s job=%s status=%s",
                    downstream_repo,
                    job_name,
                    job_status,
                )
            except Exception:
                logger.exception(
                    "l3_labeled: failed to create check run for repo=%s job=%s",
                    downstream_repo,
                    job_name,
                )

    return {"ok": True, "created_check_runs": created}


def _downstream_repo_from_check_run(name: str) -> str | None:
    """Parse the downstream ``owner/repo`` out of a check run name.

    Check runs are named ``crcr/<owner>/<repo>/<workflow_name>/<job_name>`` (see
    ``gh_helper.check_run_name``), so the downstream repo is the first two
    path segments after the ``crcr/`` prefix. Returns None for any name the
    relay didn't create.
    """
    prefix = "crcr/"
    if not name.startswith(prefix):
        return None
    parts = name[len(prefix) :].split("/")
    if len(parts) < 3 or not parts[0] or not parts[1]:
        return None
    return f"{parts[0]}/{parts[1]}"


def _is_run_already_running(exc: Exception) -> bool:
    """True for GitHub's 403 "workflow run ... is already running".

    A benign, transient outcome (the run is already re-running), not a failure
    to surface — re-running it again is impossible until it finishes.
    """
    return "already running" in str(exc).lower()


def _handle_check_run_rerequested(config: RelayConfig, payload: dict) -> dict:
    """Re-run a downstream run's failed jobs when its check run is re-requested.

    GitHub sends ``check_run`` ``rerequested`` for the "Re-run failed checks"
    button (one per failed check) and for a single check's own "Re-run", so this
    re-runs the failed jobs of that check's workflow run. The downstream run_id
    is stored as the check run's ``external_id``.
    """
    check_run = payload.get("check_run") or {}
    name = check_run.get("name", "")
    run_id = check_run.get("external_id") or ""
    downstream_repo = _downstream_repo_from_check_run(name)
    if not downstream_repo or not run_id:
        return {"ignored": True, "reason": "not a crcr check run"}

    allowlist = load_allowlist(config)
    level = allowlist.get_repo_level(downstream_repo)
    if level is None or level.value < AllowlistLevel.L3.value:
        return {"ignored": True, "reason": "downstream repo not L3+"}

    token = gh_helper.get_repo_access_token(
        config.github_app_id, config.github_app_private_key, downstream_repo
    )
    try:
        gh_helper.rerun_failed_jobs(
            token=token, repo_full_name=downstream_repo, run_id=int(run_id)
        )
    except Exception as e:
        if _is_run_already_running(e):
            logger.info(
                "check_run rerequested: run already running repo=%s run_id=%s",
                downstream_repo,
                run_id,
            )
            return {"ok": True, "rerun": [], "already_running": True}
        logger.exception(
            "check_run rerequested: rerun failed repo=%s run_id=%s",
            downstream_repo,
            run_id,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": "failed to rerun downstream run",
                "repo": downstream_repo,
                "error": str(e),
            },
        ) from e

    logger.info(
        "check_run rerequested: re-ran failed jobs repo=%s run_id=%s",
        downstream_repo,
        run_id,
    )
    return {"ok": True, "rerun": [downstream_repo]}


def _handle_check_suite_rerequested(config: RelayConfig, payload: dict) -> dict:
    """Re-run every downstream run in the re-requested suite (all jobs).

    GitHub sends ``check_suite`` ``rerequested`` only for the "Re-run all checks"
    button (the "Re-run failed checks" button instead sends a ``check_run``
    ``rerequested`` per failed check). So this reruns *all* jobs of each run via
    the run-level rerun endpoint, including ones that already succeeded.

    The CRCR app owns a single suite per commit, so listing that suite yields
    every check run it created; each carries its downstream run_id in
    ``external_id``. Check runs of the same run share a run_id, so we dedupe by
    (repo, run_id) and issue one run-level rerun per distinct run.
    """
    check_suite = payload.get("check_suite") or {}
    suite_id = check_suite.get("id")
    if not suite_id:
        return {"ignored": True, "reason": "missing check_suite id"}

    upstream_token = gh_helper.get_repo_access_token(
        config.github_app_id,
        config.github_app_private_key,
        config.upstream_repo,
    )
    check_runs = gh_helper.list_check_runs_in_suite(
        token=upstream_token,
        repo_full_name=config.upstream_repo,
        check_suite_id=suite_id,
    )

    allowlist = load_allowlist(config)
    # One installation token per downstream repo, reused across its runs.
    tokens: dict[str, str] = {}
    seen: set[tuple[str, str]] = set()
    rerun: list[str] = []
    for check_run in check_runs:
        downstream_repo = _downstream_repo_from_check_run(check_run.get("name", ""))
        run_id = check_run.get("external_id") or ""
        if not downstream_repo or not run_id:
            continue
        if (downstream_repo, run_id) in seen:
            continue
        seen.add((downstream_repo, run_id))
        level = allowlist.get_repo_level(downstream_repo)
        if level is None or level.value < AllowlistLevel.L3.value:
            continue
        try:
            token = tokens.get(downstream_repo)
            if token is None:
                token = gh_helper.get_repo_access_token(
                    config.github_app_id,
                    config.github_app_private_key,
                    downstream_repo,
                )
                tokens[downstream_repo] = token
            gh_helper.rerun_workflow_run(
                token=token, repo_full_name=downstream_repo, run_id=int(run_id)
            )
            rerun.append(downstream_repo)
        except Exception as e:
            if _is_run_already_running(e):
                logger.info(
                    "check_suite rerequested: run already running repo=%s run_id=%s",
                    downstream_repo,
                    run_id,
                )
                continue
            logger.exception(
                "check_suite rerequested: rerun failed repo=%s run_id=%s",
                downstream_repo,
                run_id,
            )

    logger.info(
        "check_suite rerequested: re-ran %d run(s) suite_id=%s", len(rerun), suite_id
    )
    return {"ok": True, "rerun": rerun}


def handle(
    config: RelayConfig, payload: dict, event_type: str, delivery_id: str
) -> dict:
    # Re-run requests for upstream check runs do not go through the dispatch
    # path; they re-trigger the existing downstream run, which re-reports via the
    # normal callback flow.
    if event_type == "check_run":
        if payload.get("action") == "rerequested":
            return _handle_check_run_rerequested(config, payload)
        return {"ignored": True}
    elif event_type == "check_suite":
        if payload.get("action") == "rerequested":
            return _handle_check_suite_rerequested(config, payload)
        return {"ignored": True}
    elif event_type == "pull_request":
        action = payload.get("action", "")
        if action == "labeled":
            label_name = (payload.get("label") or {}).get("name", "")
            if label_name.startswith("ciflow/crcr/"):
                return _handle_pr_labeled(config, payload)
            return {"ignored": True}
        elif action not in _PULL_REQUEST_ALLOW_ACTIONS:
            logger.info("pull_request action=%s ignored", action)
            return {"ignored": True}

    client_payload: EventDispatchPayload = {
        "event_type": event_type,
        "delivery_id": delivery_id,
        "payload": payload,
    }
    # GitHub repository_dispatch accepts at most 65 KB of JSON in client_payload.
    # We currently pass through the full webhook payload, so this size log helps
    # diagnose future failures if large pull_request events start breaching that limit.
    payload_size_bytes = len(
        json.dumps(client_payload, separators=(",", ":")).encode("utf-8")
    )
    logger.info(
        "dispatch payload size event_type=%s delivery=%s bytes=%d",
        event_type,
        delivery_id,
        payload_size_bytes,
    )

    dispatched, failed = _dispatch_to_allowlist(
        config=config,
        client_payload=client_payload,
    )

    if failed and dispatched:
        logger.warning(
            "partial dispatch: %d succeeded, %d failed", len(dispatched), len(failed)
        )

    if failed and not dispatched:
        logger.error("no downstream dispatch succeeded failed=%s", failed)
        raise HTTPException(
            status_code=502,
            detail={"message": "No downstream dispatch succeeded", "failed": failed},
        )

    return {"ok": True, "dispatched": dispatched, "failed": failed}
