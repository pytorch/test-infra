"""
Shared module for restarting PyTorch workflows via GitHub API.
"""

import logging

import github


def dispatch_workflow(
    client: github.Github, org: str, repo: str, workflow_name: str, commit_sha: str
) -> bool:
    # TODO: delete this useless function
    try:
        client.get_repo(f"{org}/{repo}").get_workflow(workflow_name).create_dispatch(
            ref=f"trunk/{commit_sha}", inputs={}
        )
    except github.GithubException as e:
        logging.error(
            f"Failed to dispatch workflow {workflow_name} for commit {commit_sha}: {e}"
        )
        return False
