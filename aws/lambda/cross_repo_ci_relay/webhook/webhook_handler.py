import hashlib
import hmac
import logging

from github import GithubIntegration
from github.GithubException import GithubException

import github_client_helper
import redis_helper
from config import RelayConfig
from utils import RelayHTTPException

logger = logging.getLogger(__name__)

_integration: GithubIntegration | None = None


def verify_signature(config: RelayConfig, body: bytes, signature: str) -> None:
    mac = hmac.new(config.github_webhook_secret_bytes, body, hashlib.sha256)
    expected = "sha256=" + mac.hexdigest()
    if not hmac.compare_digest(expected, signature):
        logger.warning("webhook signature mismatch")
        raise RelayHTTPException(status_code=401, detail="Bad signature")


def get_installation_token(config: RelayConfig, installation_id: int) -> str:
    global _integration
    if _integration is None:
        private_key = config.github_app_private_key
        if not private_key:
            raise RuntimeError("GITHUB_APP_PRIVATE_KEY is not configured")
        _integration = GithubIntegration(int(config.github_app_id), private_key)
        logger.debug("GithubIntegration initialized app_id=%s", config.github_app_id)

    token = _integration.get_access_token(int(installation_id)).token
    logger.debug("installation token obtained installation_id=%s", installation_id)
    return token


def _dispatch_to_allowlist(
    *,
    installation_token: str,
    allowlist_map: dict[str, str],
    event_type: str,
    client_payload: dict,
    sha: str,
    action: str,
) -> tuple[list[dict], list[dict]]:
    dispatched: list[dict] = []
    failed: list[dict] = []

    for downstream_device, downstream_repo in sorted(allowlist_map.items()):
        logger.info(
            "dispatching %s device=%s repo=%s sha=%.12s action=%s",
            event_type,
            downstream_device,
            downstream_repo,
            sha,
            action,
        )
        try:
            github_client_helper.create_repository_dispatch(
                token=installation_token,
                repo_full_name=downstream_repo,
                event_type=event_type,
                client_payload=client_payload,
                timeout=20,
            )
            dispatched.append({"downstream_device": downstream_device, "repo": downstream_repo})
            logger.info(
                "dispatch succeeded event_type=%s device=%s repo=%s",
                event_type,
                downstream_device,
                downstream_repo,
            )
        except GithubException as e:
            logger.error(
                "dispatch failed event_type=%s device=%s repo=%s status=%s data=%s",
                event_type,
                downstream_device,
                downstream_repo,
                getattr(e, "status", None),
                getattr(e, "data", None),
            )
            failed.append(
                {
                    "downstream_device": downstream_device,
                    "repo": downstream_repo,
                    "error": f"GitHub dispatch failed: status={getattr(e, 'status', None)} data={getattr(e, 'data', None)}",
                }
            )
        except Exception as e:
            logger.error(
                "dispatch failed event_type=%s device=%s repo=%s error=%s",
                event_type,
                downstream_device,
                downstream_repo,
                e,
            )
            failed.append(
                {
                    "downstream_device": downstream_device,
                    "repo": downstream_repo,
                    "error": f"GitHub dispatch failed: {e}",
                }
            )

    return dispatched, failed


def handle_github_webhook(
    config: RelayConfig,
    body: bytes,
    payload: dict,
    signature: str,
    event: str,
):
    if not signature:
        raise RelayHTTPException(status_code=400, detail="No signature")
    verify_signature(config, body, signature)

    # Only pull_request events are consumed by this relay.
    if event != "pull_request":
        logger.debug("event=%s ignored", event)
        return {"ignored": True}

    repo = payload["repository"]["full_name"]
    sha = payload["pull_request"]["head"]["sha"]
    installation_id = payload["installation"]["id"]
    action = payload["action"]

    if repo.lower() != config.upstream_repo.lower():
        logger.debug("pull_request repo=%s not upstream, ignored", repo)
        return {"ignored": True}

    installation_token = get_installation_token(config, int(installation_id))

    allowlist_info_map = redis_helper.load_allowlist_info_map(config)
    allowlist_map = {
        device: info["repo"]
        for device, info in allowlist_info_map.items()
    }
    if not allowlist_map:
        raise RelayHTTPException(status_code=400, detail="allowlist is empty")

    if action == "closed":
        in_progress = redis_helper.pop_in_progress_workflows(
            config,
            upstream_repo=repo,
            commit_sha=sha,
        )
        cancelled: list[dict] = []
        failed_cancel: list[dict] = []
        running_repos: set[str] = set()

        for wf in in_progress:
            downstream_repo = (wf.get("downstream_repo") or "").strip()
            run_id = wf.get("run_id")
            run_url = (wf.get("run_url") or "").strip()
            if not downstream_repo or not isinstance(run_id, int):
                continue
            running_repos.add(downstream_repo)
            try:
                github_client_helper.cancel_workflow_run(
                    token=installation_token,
                    repo_full_name=downstream_repo,
                    run_id=run_id,
                    timeout=20,
                )
                redis_helper.register_cancelled_workflow(config, run_url=run_url)
                cancelled.append({"repo": downstream_repo, "run_id": run_id})
            except GithubException as e:
                failed_cancel.append(
                    {
                        "repo": downstream_repo,
                        "run_id": run_id,
                        "error": f"GitHub cancel failed: status={getattr(e, 'status', None)} data={getattr(e, 'data', None)}",
                    }
                )
            except Exception as e:
                failed_cancel.append(
                    {"repo": downstream_repo, "run_id": run_id, "error": f"GitHub cancel failed: {e}"}
                )

        marked_pending: list[dict] = []
        for downstream_repo in sorted(set(allowlist_map.values())):
            if downstream_repo in running_repos:
                continue
            redis_helper.register_pending_pr_close(
                config,
                upstream_repo=repo,
                commit_sha=sha,
                downstream_repo=downstream_repo,
            )
            marked_pending.append({"repo": downstream_repo})

        return {
            "ok": True,
            "action": "closed",
            "cancelled": cancelled,
            "failed_cancel": failed_cancel,
            "marked_pending": marked_pending,
        }

    if action not in ("opened", "reopened", "synchronize"):
        logger.debug("pull_request action=%s ignored", action)
        return {"ignored": True}

    dispatched, failed = _dispatch_to_allowlist(
        installation_token=installation_token,
        allowlist_map=allowlist_map,
        event_type="pytorch-pr-trigger",
        client_payload={"upstream_repo": repo, "commit_sha": sha},
        sha=sha,
        action=action,
    )

    if not dispatched:
        logger.error("no downstream dispatch succeeded failed=%s", failed)
        raise RelayHTTPException(
            status_code=403,
            detail={
                "message": "No downstream dispatch succeeded",
                "failed": failed,
            },
        )

    return {"ok": True, "dispatched": dispatched, "failed": failed}
