from __future__ import annotations

import json
import logging
import time
from concurrent.futures import as_completed, ThreadPoolExecutor

from utils import gh_helper, redis_helper
from utils.allowlist import AllowlistLevel, load_allowlist
from utils.config import RelayConfig
from utils.misc import EventDispatchPayload, HTTPException, TimingPhase


logger = logging.getLogger(__name__)
_PULL_REQUEST_ALLOW_ACTIONS = frozenset({"opened", "reopened", "synchronize", "closed"})


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

    # Record dispatch timestamp for timing calculations (best-effort).
    # Keyed by X-GitHub-Delivery (globally unique per webhook delivery) so
    # retries/reruns with the same head_sha don't collide.
    redis_helper.set_timing(
        config,
        client_payload.get("delivery_id"),
        downstream_repo,
        TimingPhase.DISPATCH,
        time.time(),
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


def handle(
    config: RelayConfig, payload: dict, event_type: str, delivery_id: str
) -> dict:
    if event_type == "pull_request":
        action = payload.get("action", "")
        if action not in _PULL_REQUEST_ALLOW_ACTIONS:
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
