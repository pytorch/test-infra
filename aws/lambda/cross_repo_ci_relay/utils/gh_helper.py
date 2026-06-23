"""GitHub API helpers"""

import logging

import github
from github import GithubIntegration

from .misc import EventDispatchPayload


logger = logging.getLogger(__name__)


def check_run_name(downstream_repo: str, workflow_name: str) -> str:
    """Canonical check run name shown on the upstream PR (e.g. 'crcr/org/repo/CI')."""
    return f"crcr/{downstream_repo}/{workflow_name}"


def get_repo_access_token(
    app_id: str,
    private_key: str,
    repo_full_name: str,
    gh_client: GithubIntegration | None = None,
) -> str:
    """Return an installation access token scoped to the app installation for a repository."""
    if gh_client is None:
        try:
            app_id_int = int(app_id)
        except ValueError:
            raise RuntimeError(f"GITHUB_APP_ID must be a valid integer, got {app_id!r}")
        gh_client = GithubIntegration(app_id_int, private_key)

    try:
        owner, repo = repo_full_name.split("/", 1)
    except ValueError as exc:
        raise RuntimeError(
            f"Repository name must be in 'owner/repo' format, got {repo_full_name!r}"
        ) from exc

    installation = gh_client.get_repo_installation(owner, repo)
    return gh_client.get_access_token(installation.id).token


def rerun_workflow(
    *,
    token: str,
    repo_full_name: str,
    run_id: int,
    timeout: int = 20,
    gh_client: github.Github | None = None,
) -> None:
    """Trigger a re-run of an existing downstream workflow run by its run_id."""
    logger.info("rerun_workflow repo=%s run_id=%d", repo_full_name, run_id)
    if gh_client is None:
        gh_client = github.Github(login_or_token=token, timeout=timeout)
    gh_client.get_repo(repo_full_name).get_workflow_run(run_id).rerun()


def create_repository_dispatch(
    *,
    token: str,
    repo_full_name: str,
    event_type: str,
    client_payload: EventDispatchPayload,
    timeout: int = 20,
    gh_client: github.Github | None = None,
) -> None:
    """Trigger a repository_dispatch event via PyGithub."""
    logger.info("repository_dispatch repo=%s event_type=%s", repo_full_name, event_type)
    if gh_client is None:
        gh_client = github.Github(login_or_token=token, timeout=timeout)
    gh_client.get_repo(repo_full_name).create_repository_dispatch(
        event_type, dict(client_payload)
    )


def build_check_run_output(
    status: str,
    conclusion: str,
    details_url: str,
    downstream_repo: str,
) -> dict:
    """Return a GitHub Check Run output dict shown in the detail panel."""
    if status != "completed":
        title = "In progress"
    elif conclusion:
        title = conclusion.capitalize()
    else:
        title = "Completed"
    return {
        "title": title,
        "summary": f"{downstream_repo} workflow: {details_url}",
    }


def create_check_run(
    *,
    token: str,
    repo_full_name: str,
    name: str,
    head_sha: str,
    status: str,
    conclusion: str | None = None,
    details_url: str | None = None,
    external_id: str | None = None,
    output: dict | None = None,
    timeout: int = 20,
    gh_client: github.Github | None = None,
) -> int:
    """Create a check run on the upstream repo. Returns the check run ID.

    Pass status='completed' and conclusion for Scenario 3 (label arrives after
    workflow has already finished — create a completed check run directly).
    external_id stores the downstream workflow run_id so rerequested events can
    identify the original run.
    output (optional) sets the detail-panel content: {"title": str, "summary": str}.
    """
    logger.info(
        "create_check_run repo=%s name=%s status=%s", repo_full_name, name, status
    )
    if gh_client is None:
        gh_client = github.Github(login_or_token=token, timeout=timeout)
    create_kwargs: dict = {"name": name, "head_sha": head_sha, "status": status}
    if status == "completed" and conclusion is not None:
        create_kwargs["conclusion"] = conclusion
    if details_url is not None:
        create_kwargs["details_url"] = details_url
    if external_id is not None:
        create_kwargs["external_id"] = external_id
    if output is not None:
        create_kwargs["output"] = output
    check_run = gh_client.get_repo(repo_full_name).create_check_run(**create_kwargs)
    return check_run.id


def get_repo_file(
    owner: str,
    repo: str,
    file_path: str,
    ref: str,
    gh_client: github.Github | None = None,
) -> str:
    """Fetch a file's decoded text content from a GitHub repository (unauthenticated)."""
    if gh_client is None:
        gh_client = github.Github(timeout=20)
    content_file = gh_client.get_repo(f"{owner}/{repo}").get_contents(
        file_path, ref=ref
    )

    if isinstance(content_file, list):
        raise RuntimeError(
            f"Path is a directory, not a file: {owner}/{repo}/{file_path}@{ref}"
        )

    return content_file.decoded_content.decode("utf-8")
