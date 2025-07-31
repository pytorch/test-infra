"""
WorkflowRestartChecker for querying restarted workflows via ClickHouse.
"""

import logging
import os
from datetime import datetime, timedelta
from typing import Dict, Set

import requests

from .clickhouse_client_helper import CHCliFactory


class WorkflowRestartChecker:
    """Check if workflows have been restarted using ClickHouse."""

    def __init__(self):
        self._cache: Dict[str, bool] = {}

    def has_restarted_workflow(self, workflow_name: str, commit_sha: str) -> bool:
        """
        Check if a workflow has been restarted for given commit.

        Args:
            workflow_name: Name of workflow (e.g., "trunk" or "trunk.yml")
            commit_sha: Commit SHA to check

        Returns:
            bool: True if workflow was restarted (workflow_dispatch with trunk/* branch)
        """
        # Normalize workflow name - remove .yml extension for consistency
        normalized_workflow_name = workflow_name.replace(".yml", "")
        cache_key = f"{normalized_workflow_name}:{commit_sha}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        query = """
        SELECT 1 as count
        FROM workflow_job FINAL
        WHERE (id, run_id) IN (
          SELECT DISTINCT id, run_id
          FROM materialized_views.workflow_job_by_head_sha
          WHERE head_sha = {commit_sha:String}
        )
          AND workflow_event = {workflow_event:String}
          AND head_branch = {head_branch:String}
          AND workflow_name = {workflow_name:String}
        LIMIT 1
        """

        result = CHCliFactory().client.query(
            query,
            {
                "commit_sha": commit_sha,
                "workflow_event": "workflow_dispatch",
                "head_branch": f"trunk/{commit_sha}",
                "workflow_name": normalized_workflow_name,
            },
        )

        has_restart = len(result.result_rows) > 0
        self._cache[cache_key] = has_restart
        return has_restart

    def get_restarted_commits(self, workflow_name: str, days_back: int = 7) -> Set[str]:
        """
        Get all commits with restarted workflows in date range.

        Args:
            workflow_name: Name of workflow (e.g., "trunk" or "trunk.yml")
            days_back: Number of days to look back

        Returns:
            Set of commit SHAs that have restarted workflows
        """
        # Normalize workflow name - remove .yml extension for consistency
        normalized_workflow_name = workflow_name.replace(".yml", "")
        since_date = datetime.now() - timedelta(days=days_back)

        query = """
        SELECT DISTINCT head_sha
        FROM workflow_job
        WHERE workflow_event = 'workflow_dispatch'
          AND head_branch LIKE 'trunk/%'
          AND workflow_name = {workflow_name:String}
          AND workflow_created_at >= {since_date:DateTime}
        """

        result = CHCliFactory().client.query(
            query, {"workflow_name": normalized_workflow_name, "since_date": since_date}
        )

        commits = {row[0] for row in result.result_rows}

        # Update cache
        for commit_sha in commits:
            cache_key = f"{normalized_workflow_name}:{commit_sha}"
            self._cache[cache_key] = True

        return commits

    def clear_cache(self):
        """Clear the results cache."""
        self._cache.clear()

    def restart_workflow(self, workflow_name: str, commit_sha: str) -> bool:
        """
        Restart a workflow for a specific commit SHA.

        Args:
            workflow_name: Name of the workflow (e.g., "trunk" or "trunk.yml")
            commit_sha: The commit SHA to restart workflow for

        Returns:
            bool: True if workflow was successfully dispatched, False otherwise
        """
        # Normalize workflow name
        normalized_workflow_name = workflow_name.replace(".yml", "")

        # Check if already restarted
        if self.has_restarted_workflow(normalized_workflow_name, commit_sha):
            logging.warning(
                f"Workflow {normalized_workflow_name} already restarted for commit {commit_sha}"
            )
            return False

        # Use GitHub token from environment or client
        github_token = os.getenv("GITHUB_TOKEN")
        if not github_token:
            # Try to get from GitHub client if available
            try:
                from .github_client_helper import GHClientFactory

                if GHClientFactory().token_auth_provided:
                    github_token = GHClientFactory()._token
            except Exception:
                pass

        if not github_token:
            logging.error("GITHUB_TOKEN not available for workflow dispatch")
            return False

        repo_owner = os.getenv("GITHUB_REPO_OWNER", "pytorch")
        repo_name = os.getenv("GITHUB_REPO_NAME", "pytorch")

        try:
            # Use trunk/{sha} tag format
            tag_ref = f"trunk/{commit_sha}"

            # Add .yml extension for API call
            workflow_file_name = f"{normalized_workflow_name}.yml"

            url = (
                f"https://api.github.com/repos/{repo_owner}/{repo_name}"
                f"/actions/workflows/{workflow_file_name}/dispatches"
            )
            headers = {
                "Authorization": f"token {github_token}",
                "Accept": "application/vnd.github.v3+json",
            }
            data = {"ref": tag_ref, "inputs": {}}

            response = requests.post(url, headers=headers, json=data)

            if response.status_code == 204:
                # Construct the workflow runs URL
                workflow_url = (
                    f"https://github.com/{repo_owner}/{repo_name}"
                    f"/actions/workflows/{workflow_file_name}"
                    f"?query=branch%3Atrunk%2F{commit_sha}"
                )
                logging.info(
                    f"Successfully dispatched workflow {normalized_workflow_name} for commit {commit_sha}\n"
                    f"  View at: {workflow_url}"
                )

                # Invalidate cache for this workflow/commit
                cache_key = f"{normalized_workflow_name}:{commit_sha}"
                if cache_key in self._cache:
                    del self._cache[cache_key]
                return True
            else:
                logging.error(
                    f"Failed to dispatch workflow: {response.status_code} - {response.text}"
                )
                return False

        except Exception as e:
            logging.error(f"Error dispatching workflow {normalized_workflow_name}: {e}")
            return False
