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
    DISPATCH_CHECK_RUN_ID,
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
    # Keyed by delivery_id + repo + DISPATCH_JOB_NAME="*" (repo-level, not job-specific).
    # Timestamp is used for queue_time calculation (dispatch → in_progress).
    redis_helper.set_callback_state(
        config,
        client_payload["delivery_id"],
        downstream_repo,
        DISPATCH_CHECK_RUN_ID,
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
    for downstream_repo in l3_repos:
        redis_helper.mark_check_run_wanted(config, head_sha, downstream_repo)
        job_info = redis_helper.get_dispatch_workflow(config, head_sha, downstream_repo)
        if not job_info:
            logger.info(
                "l3_labeled: no job info for repo=%s; check run marked wanted for callback",
                downstream_repo,
            )
            continue

        try:
            upstream_token = gh_helper.get_repo_access_token(
                config.github_app_id,
                config.github_app_private_key,
                config.upstream_repo,
            )

            job_status = job_info.get("status")
            job_conclusion = job_info.get("conclusion")
            workflow_name = job_info.get("workflow_name")
            external_id = job_info.get("run_id")  # opaque run identifier
            details_url = job_info.get("job_url")  # full URL for the link

            if job_status == "in_progress":
                gh_helper.create_check_run(
                    token=upstream_token,
                    repo_full_name=config.upstream_repo,
                    name=gh_helper.check_run_name(downstream_repo, workflow_name),
                    head_sha=head_sha,
                    status="in_progress",
                    details_url=details_url,
                    external_id=external_id,
                    output=gh_helper.build_check_run_output(
                        workflow_name, details_url, downstream_repo
                    ),
                )
            elif job_status == "completed":
                gh_helper.create_check_run(
                    token=upstream_token,
                    repo_full_name=config.upstream_repo,
                    name=gh_helper.check_run_name(downstream_repo, workflow_name),
                    head_sha=head_sha,
                    status="completed",
                    conclusion=job_conclusion,
                    details_url=details_url,
                    external_id=external_id,
                    output=gh_helper.build_check_run_output(
                        workflow_name, details_url, downstream_repo
                    ),
                )
            else:
                continue

            created.append(downstream_repo)
            logger.info(
                "l3_labeled: check run created repo=%s status=%s",
                downstream_repo,
                job_status,
            )
        except Exception:
            logger.exception(
                "l3_labeled: failed to create check run for repo=%s", downstream_repo
            )

    return {"ok": True, "created_check_runs": created}


def handle(
    config: RelayConfig, payload: dict, event_type: str, delivery_id: str
) -> dict:
    if event_type == "pull_request":
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
