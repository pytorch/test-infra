import logging
import re

import github
import jwt
from github import GithubIntegration
from jwt import PyJWKClient

from config import RelayConfig
from utils import RelayHTTPException
from clickhouse_client_helper import CHCliFactory
import redis_helper

logger = logging.getLogger(__name__)

_github_actions_jwk_client = PyJWKClient(
    "https://token.actions.githubusercontent.com/.well-known/jwks"
)
_github_integration: GithubIntegration | None = None


def verify_github_actions_oidc_token(authorization: str) -> dict:
    if not authorization:
        raise RelayHTTPException(status_code=401, detail="Missing Authorization header")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise RelayHTTPException(status_code=401, detail="Invalid Authorization header")

    try:
        signing_key = _github_actions_jwk_client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer="https://token.actions.githubusercontent.com",
            options={"verify_aud": False, "require": ["exp"]},
        )
    except Exception as exc:
        logger.warning("ci/result OIDC token verification failed: %s", exc)
        raise RelayHTTPException(status_code=401, detail="Invalid token") from exc


def _get_github_integration(config: RelayConfig) -> GithubIntegration:
    global _github_integration
    if _github_integration is None:
        if not config.github_app_id or not config.github_app_private_key:
            raise RuntimeError("GitHub App credentials are not configured for result cancellation")
        _github_integration = GithubIntegration(int(config.github_app_id), config.github_app_private_key)
    return _github_integration


def cancel_workflow_run(config: RelayConfig, repo_full_name: str, run_id: int) -> None:
    owner, repo = repo_full_name.split("/", 1)
    integration = _get_github_integration(config)
    installation = integration.get_repo_installation(owner, repo)
    token = integration.get_access_token(int(installation.id)).token
    gh = github.Github(auth=github.Auth.Token(token), timeout=20)
    requester = gh._Github__requester
    requester.requestJsonAndCheck(
        "POST",
        f"/repos/{repo_full_name}/actions/runs/{run_id}/cancel",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    logger.info("workflow_run cancel requested from result route repo=%s run_id=%s", repo_full_name, run_id)


def handle_ci_result(
    config: RelayConfig,
    data: dict,
    authorization: str,
):
    oidc_claims = verify_github_actions_oidc_token(authorization)

    run_url = data.get("url", "")
    if not run_url:
        raise RelayHTTPException(status_code=400, detail="Missing url")

    logger.debug("ci/result received url=%s", run_url)
    allowlist = redis_helper.load_allowlist_info_map(config)

    matched = re.search(r"github\.com/([^/]+)/([^/]+)/(?:actions/)?runs/(\d+)", run_url)
    if matched:
        repo_html_url = f"https://github.com/{matched.group(1)}/{matched.group(2)}"
        run_id = int(matched.group(3))
    else:
        matched = re.search(
            r"api\.github\.com/repos/([^/]+)/([^/]+)/actions/runs/(\d+)", run_url
        )
        repo_html_url = (
            f"https://github.com/{matched.group(1)}/{matched.group(2)}"
            if matched
            else None
        )
        run_id = int(matched.group(3)) if matched else None

    if not repo_html_url or run_id is None:
        raise RelayHTTPException(status_code=400, detail=f"Unsupported url: {run_url}")

    repo_full_name = repo_html_url.removeprefix("https://github.com/").rstrip("/")
    token_repository = oidc_claims.get("repository")
    if token_repository != repo_full_name:
        logger.warning(
            "ci/result token repository mismatch token_repo=%s run_repo=%s",
            token_repository,
            repo_full_name,
        )
        raise RelayHTTPException(
            status_code=403,
            detail="Token repository does not match result repository",
        )

    norm = repo_html_url.rstrip("/")
    device = next(
        (name for name, info in allowlist.items() if info["url"] == norm), None
    )
    if not device:
        logger.warning("ci/result rejected repo=%s not in allowlist", repo_html_url)
        raise RelayHTTPException(
            status_code=403,
            detail={
                "message": "ci/result rejected: repo not in allowlist",
                "repo_html_url": repo_html_url,
                "allowed": sorted(info["url"] for info in allowlist.values()),
            },
        )

    info = allowlist[device]
    level = info["level"]

    try:
        workflow_name = data["workflow_name"]
        upstream_repo = data["upstream_repo"]
        commit_sha = data["commit_sha"]
    except KeyError as e:
        raise RelayHTTPException(status_code=400, detail=f"Missing required field: {e}") from e

    status = (data.get("status") or "").strip()
    conclusion = (data.get("conclusion") or "").strip()

    if not status:
        raise RelayHTTPException(status_code=400, detail="Missing required field: status")

    pending_close = False
    if status != "completed":
        pending_close = redis_helper.consume_pending_pr_close(
            config,
            upstream_repo=upstream_repo,
            commit_sha=commit_sha,
            downstream_repo=repo_full_name,
        )
        if pending_close:
            cancel_workflow_run(config, repo_full_name, run_id)
            redis_helper.register_cancelled_workflow(config, run_url=run_url)
        else:
            redis_helper.register_in_progress_workflow(
                config,
                upstream_repo=upstream_repo,
                commit_sha=commit_sha,
                downstream_repo=repo_full_name,
                run_id=run_id,
                run_url=run_url,
                workflow_name=workflow_name,
            )
    else:
        redis_helper.remove_in_progress_workflow(
            config,
            upstream_repo=upstream_repo,
            commit_sha=commit_sha,
            downstream_repo=repo_full_name,
            run_id=run_id,
        )

    cancelled_after_close = False
    if status == "completed":
        cancelled_after_close = redis_helper.consume_cancelled_workflow(
            config,
            run_url=run_url,
        )

    logger.info(
        "ci/result device=%s level=%s conclusion=%s workflow=%s sha=%.12s",
        device, level, conclusion, workflow_name, commit_sha,
    )

    if level == "L1":
        if cancelled_after_close or pending_close:
            return {"ok": True, "action": "cancelled"}
        return {"ok": True, "action": "ignored"}

    CHCliFactory.setup_client(
        url=config.clickhouse_url,
        username=config.clickhouse_user,
        password=config.clickhouse_password,
        database=config.clickhouse_database,
    )

    CHCliFactory.ensure_table()
    if cancelled_after_close:
        CHCliFactory.update_ci_result_by_run_url(
            run_url=run_url,
            status="cancelled",
            conclusion="cancelled",
        )
        logger.info("ci/result updated existing ClickHouse row to cancelled device=%s", device)
        return {"ok": True, "action": "cancelled"}

    CHCliFactory.write_ci_result(
        device=device,
        upstream_repo=upstream_repo,
        commit_sha=commit_sha,
        workflow_name=workflow_name,
        status=status,
        conclusion=conclusion,
        run_url=run_url,
    )
    logger.info("ci/result written to ClickHouse device=%s", device)

    if pending_close:
        return {"ok": True, "action": "cancelled"}

    if level == "L2":
        return {"ok": True, "action": "hud_only"}

    return {"ok": True, "action": "recorded"}
