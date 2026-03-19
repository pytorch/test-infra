import logging

import github

logger = logging.getLogger(__name__)

_clients: dict[tuple[str, int], github.Github] = {}


def _get_client(token: str, timeout: int) -> github.Github:
    key = (token, timeout)
    if key not in _clients:
        _clients[key] = github.Github(auth=github.Auth.Token(token), timeout=timeout)
    return _clients[key]


def create_repository_dispatch(
    *,
    token: str,
    repo_full_name: str,
    event_type: str,
    client_payload: dict,
    timeout: int = 20,
) -> None:
    gh = _get_client(token, timeout)
    logger.debug("repository_dispatch repo=%s event_type=%s", repo_full_name, event_type)
    gh.get_repo(repo_full_name).create_repository_dispatch(event_type, client_payload)


def cancel_workflow_run(
    *,
    token: str,
    repo_full_name: str,
    run_id: int,
    timeout: int = 20,
) -> None:
    gh = _get_client(token, timeout)
    requester = gh._Github__requester
    requester.requestJsonAndCheck(
        "POST",
        f"/repos/{repo_full_name}/actions/runs/{run_id}/cancel",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    logger.info("workflow_run cancel requested repo=%s run_id=%s", repo_full_name, run_id)
