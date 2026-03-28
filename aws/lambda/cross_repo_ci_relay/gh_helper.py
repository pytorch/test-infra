"""GitHub API helpers"""

import logging

import github
from github import GithubIntegration
from utils import PRDispatchPayload


logger = logging.getLogger(__name__)


def get_access_token(
    app_id: str,
    private_key: str,
    installation_id: int,
    gh_client: GithubIntegration | None = None,
) -> str:
    """Return a short-lived installation access token for the given GitHub App installation."""
    if gh_client is None:
        try:
            app_id_int = int(app_id)
        except ValueError:
            raise RuntimeError(f"GITHUB_APP_ID must be a valid integer, got {app_id!r}")
        gh_client = GithubIntegration(app_id_int, private_key)
    return gh_client.get_access_token(installation_id).token


def create_repository_dispatch(
    *,
    token: str,
    repo_full_name: str,
    event_type: str,
    client_payload: PRDispatchPayload,
    timeout: int = 20,
    gh_client: github.Github | None = None,
) -> None:
    """Trigger a repository_dispatch event via PyGithub."""
    logger.debug(
        "repository_dispatch repo=%s event_type=%s", repo_full_name, event_type
    )
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
