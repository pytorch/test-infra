from __future__ import annotations

import logging
import os
from concurrent.futures import as_completed, ThreadPoolExecutor

import gh_helper
from allowlist import AllowlistLevel, load_allowlist
from config import RelayConfig
from utils import EventDispatchPayload, HTTPException


logger = logging.getLogger(__name__)
_PULL_REQUEST_ALLOW_ACTIONS = frozenset({"opened", "reopened", "synchronize"})


def _dispatch_one(
    *,
    config: RelayConfig,
    downstream_repo: str,
    event_type: str,
    client_payload: EventDispatchPayload,
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

    dispatched: list[dict] = []
    failed: list[dict] = []
    # Limit max workers to avoid overwhelming GitHub API and
    # to prevent excessive resource usage in the Lambda function
    max_workers = min(
        len(targets), 2 * (os.cpu_count() or 1), config.max_dispatch_workers
    )
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_repo = {
            pool.submit(
                _dispatch_one,
                config=config,
                downstream_repo=downstream_repo,
                event_type=event_type,
                client_payload=client_payload,
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
                error_message = str(e)
                logger.error(
                    "dispatch failed event_type=%s repo=%s error=%s",
                    event_type,
                    downstream_repo,
                    error_message,
                )
                failed.append(
                    {
                        "repo": downstream_repo,
                        "error": f"GitHub dispatch failed: {error_message}",
                    }
                )
    return dispatched, failed


def handle(
    config: RelayConfig, payload: dict, event_type: str, delivery_id: str
) -> dict:
    if event_type == "pull_request":
        action = payload.get("action", "")
        if action not in _PULL_REQUEST_ALLOW_ACTIONS:
            logger.info("pull_request action=%s ignored", action)
            return {"ignored": True}

    dispatched, failed = _dispatch_to_allowlist(
        config=config,
        client_payload={
            "event_type": event_type,
            "delivery_id": delivery_id,
            "payload": payload,
        },
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
