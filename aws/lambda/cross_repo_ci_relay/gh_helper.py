"""GitHub API helpers"""

import logging

import github
from github import GithubIntegration
from utils import EventDispatchPayload


logger = logging.getLogger(__name__)


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
