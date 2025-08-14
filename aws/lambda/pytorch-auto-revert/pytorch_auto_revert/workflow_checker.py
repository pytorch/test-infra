"""
WorkflowRestartChecker for querying restarted workflows via ClickHouse and
dispatching workflows via GitHub with consistent workflow name resolution.
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, Set

from .clickhouse_client_helper import CHCliFactory
from .workflow_resolver import WorkflowResolver


class WorkflowRestartChecker:
    """Check if workflows have been restarted using ClickHouse."""

    def __init__(self, repo_owner: str = "pytorch", repo_name: str = "pytorch"):
        self._cache: Dict[str, bool] = {}
        self.repo_owner = repo_owner
        self.repo_name = repo_name

    def has_restarted_workflow(self, workflow_name: str, commit_sha: str) -> bool:
        """
        Check if a workflow has been restarted for given commit.

        Args:
            workflow_name: Name of workflow (e.g., "trunk" or "trunk.yml")
            commit_sha: Commit SHA to check

        Returns:
            bool: True if workflow was restarted (workflow_dispatch with trunk/* branch)
        """
        # Resolve to display name via GitHub (exact display or file name)
        display_name = self.resolver.require(workflow_name).display_name

        cache_key = f"{display_name}:{commit_sha}"
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
                "workflow_name": display_name,
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
        display_name = self.resolver.require(workflow_name).display_name
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
            query, {"workflow_name": display_name, "since_date": since_date}
        )

        commits = {row[0] for row in result.result_rows}

        # Update cache
        for commit_sha in commits:
            cache_key = f"{display_name}:{commit_sha}"
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
        # Check if already restarted
        if self.has_restarted_workflow(workflow_name, commit_sha):
            logging.warning(
                f"Workflow {workflow_name} already restarted for commit {commit_sha}"
            )
            return False

        # Get GitHub client
        try:
            from .github_client_helper import GHClientFactory

            if not (
                GHClientFactory().token_auth_provided
                or GHClientFactory().key_auth_provided
            ):
                logging.error("GitHub authentication not configured")
                return False

            client = GHClientFactory().client
        except Exception as e:
            logging.error(f"Failed to get GitHub client: {e}")
            return False

        try:
            # Use trunk/{sha} tag format
            tag_ref = f"trunk/{commit_sha}"

            # Resolve workflow
            wf_ref = self.resolver.require(workflow_name)

            # Dispatch via file name
            client.get_repo(f"{self.repo_owner}/{self.repo_name}").get_workflow(
                wf_ref.file_name
            ).create_dispatch(ref=tag_ref, inputs={})

            # Construct the workflow runs URL
            workflow_url = (
                f"https://github.com/{self.repo_owner}/{self.repo_name}"
                f"/actions/workflows/{wf_ref.file_name}"
                f"?query=branch%3Atrunk%2F{commit_sha}"
            )
            logging.info(
                f"Successfully dispatched workflow {wf_ref.display_name} for commit {commit_sha}\n"
                f"  View at: {workflow_url}"
            )

            # Invalidate cache for this workflow/commit
            cache_key = f"{wf_ref.display_name}:{commit_sha}"
            if cache_key in self._cache:
                del self._cache[cache_key]
            return True

        except Exception as e:
            logging.error(f"Error dispatching workflow {workflow_name}: {e}")
            return False

    def resolver(self) -> WorkflowResolver:
        return WorkflowResolver.get(f"{self.repo_owner}/{self.repo_name}")
