from __future__ import annotations

import logging
from dataclasses import dataclass

import gh_helper
from allowlist import AllowlistLevel, load_allowlist
from config import RelayConfig
from github import GithubException
from utils import HTTPException, PRDispatchPayload


@dataclass(frozen=True)
class PREvent:
    repo: str
    sha: str
    pr_number: int
    head_ref: str
    base_ref: str
    installation_id: int
    action: str


def extract_pr_fields(payload: dict) -> PREvent:
    try:
        return PREvent(
            repo=payload["repository"]["full_name"],
            sha=payload["pull_request"]["head"]["sha"],
            pr_number=payload["pull_request"]["number"],
            head_ref=payload["pull_request"]["head"]["ref"],
            base_ref=payload["pull_request"]["base"]["ref"],
            installation_id=payload["installation"]["id"],
            action=payload["action"],
        )
    except KeyError as e:
        raise HTTPException(
            status_code=400, detail=f"Missing required field: {e}"
        ) from e


logger = logging.getLogger(__name__)


def _dispatch_to_allowlist(
    *,
    config: RelayConfig,
    installation_id: int,
    client_payload: PRDispatchPayload,
    action: str,
    event_type: str = "pytorch-pr-trigger",
) -> tuple[list[dict], list[dict]]:
    # Check allowlist first — avoid unnecessary token fetch if there's nothing to dispatch
    allowlist = load_allowlist(config)
    backends, _ = allowlist.get_from_level(AllowlistLevel.L1)
    if not backends:
        logger.info("allowlist is empty, nothing to dispatch")
        return [], []

    installation_token = gh_helper.get_access_token(
        config.github_app_id, config.github_app_private_key, installation_id
    )

    sha = client_payload["head_sha"]
    targets = sorted(backends)

    dispatched: list[dict] = []
    failed: list[dict] = []
    # Currently the dispatching is done sequentially, which is simpler and good enough for the expected scale.
    # But in the future, when downstream repo is getting more and more,
    # the dispatching should be optimized to parallel.
    for downstream_repo in targets:
        logger.info(
            "dispatching %s repo=%s sha=%.12s action=%s",
            event_type,
            downstream_repo,
            sha,
            action,
        )
        try:
            gh_helper.create_repository_dispatch(
                token=installation_token,
                repo_full_name=downstream_repo,
                event_type=event_type,
                client_payload=client_payload,
            )
            logger.info(
                "dispatch succeeded event_type=%s repo=%s",
                event_type,
                downstream_repo,
            )
            dispatched.append({"repo": downstream_repo})
        except GithubException as e:
            logger.error(
                "dispatch failed event_type=%s repo=%s status=%s data=%s",
                event_type,
                downstream_repo,
                e.status,
                e.data,
            )
            failed.append(
                {
                    "repo": downstream_repo,
                    "error": f"GitHub dispatch failed: status={e.status} data={e.data}",
                }
            )
        except Exception as e:
            logger.error(
                "dispatch failed event_type=%s repo=%s error=%s",
                event_type,
                downstream_repo,
                e,
            )
            failed.append(
                {"repo": downstream_repo, "error": f"GitHub dispatch failed: {e}"}
            )

    return dispatched, failed


def handle(config: RelayConfig, payload: dict) -> dict:
    event: PREvent = extract_pr_fields(payload)

    if event.action not in ("opened", "reopened", "synchronize"):
        logger.info("pull_request action=%s ignored", event.action)
        return {"ignored": True}

    dispatched, failed = _dispatch_to_allowlist(
        config=config,
        installation_id=event.installation_id,
        client_payload={
            "upstream_repo": event.repo,
            "head_sha": event.sha,
            "pr_number": event.pr_number,
            "head_ref": event.head_ref,
            "base_ref": event.base_ref,
        },
        action=event.action,
    )

    if failed and dispatched:
        logger.warning("partial dispatch: %d succeeded, %d failed", len(dispatched), len(failed))

    if failed and not dispatched:
        logger.error("no downstream dispatch succeeded failed=%s", failed)
        raise HTTPException(
            status_code=502,
            detail={"message": "No downstream dispatch succeeded", "failed": failed},
        )

    return {"ok": True, "dispatched": dispatched, "failed": failed}
