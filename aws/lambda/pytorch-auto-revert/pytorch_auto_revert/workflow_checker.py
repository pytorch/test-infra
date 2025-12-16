"""
WorkflowRestartChecker for querying restarted workflows via ClickHouse and
dispatching workflows via GitHub with consistent workflow name resolution.
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, FrozenSet, Set

from .clickhouse_client_helper import CHCliFactory
from .utils import proper_workflow_create_dispatch, RetryWithBackoff
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

        for attempt in RetryWithBackoff():
            with attempt:
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

        for attempt in RetryWithBackoff():
            with attempt:
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

    def restart_workflow(
        self,
        workflow_name: str,
        commit_sha: str,
        jobs_to_include: FrozenSet[str] = frozenset(),
        tests_to_include: FrozenSet[str] = frozenset(),
    ) -> None:
        """
        Restart a workflow for a specific commit SHA with optional filtering.

        Args:
            workflow_name: Name of the workflow (e.g., "trunk" or "trunk.yml")
            commit_sha: The commit SHA to restart workflow for
            jobs_to_include: Job display names to filter (empty = all jobs)
            tests_to_include: Test module paths to filter (empty = all tests)

        Raises:
            RuntimeError: If GitHub authentication is not configured.
            GithubException: If the GitHub API rejects the dispatch
                (e.g., workflow not found, insufficient permissions, rate limit exceeded, or validation error).
            Exception: For unexpected client or network errors during the dispatch request.
        """
        from .github_client_helper import GHClientFactory

        factory = GHClientFactory()
        if not (factory.token_auth_provided or factory.key_auth_provided):
            raise RuntimeError("GitHub authentication not configured")

        client = factory.client

        # Use trunk/{sha} tag format
        tag_ref = f"trunk/{commit_sha}"

        # Resolve workflow (exact display or file name)
        wf_ref = self.resolver.require(workflow_name)

        # Check what inputs this workflow supports
        input_support = self.resolver.get_input_support(workflow_name)

        # Build inputs dict based on support and available filters
        inputs: Dict[str, str] = {}
        if input_support.jobs_to_include and jobs_to_include:
            inputs["jobs-to-include"] = " ".join(jobs_to_include)
        if input_support.tests_to_include and tests_to_include:
            inputs["tests-to-include"] = " ".join(tests_to_include)

        for attempt in RetryWithBackoff():
            with attempt:
                repo = client.get_repo(f"{self.repo_owner}/{self.repo_name}")
                workflow = repo.get_workflow(wf_ref.file_name)
                proper_workflow_create_dispatch(workflow, ref=tag_ref, inputs=inputs)

        workflow_url = (
            f"https://github.com/{self.repo_owner}/{self.repo_name}"
            f"/actions/workflows/{wf_ref.file_name}?query=branch%3Atrunk%2F{commit_sha}"
        )

        # Log what was dispatched with filter info
        filter_info = ""
        if inputs:
            filter_parts = []
            if "jobs-to-include" in inputs:
                filter_parts.append(f"jobs={inputs['jobs-to-include']}")
            if "tests-to-include" in inputs:
                filter_parts.append(f"tests={inputs['tests-to-include']}")
            filter_info = f" with filters: {', '.join(filter_parts)}"

        logging.info(
            "Successfully dispatched workflow %s for commit %s%s (run: %s)",
            wf_ref.display_name,
            commit_sha,
            filter_info,
            workflow_url,
        )

        cache_key = f"{wf_ref.display_name}:{commit_sha}"
        if cache_key in self._cache:
            del self._cache[cache_key]

    @property
    def resolver(self) -> WorkflowResolver:
        return WorkflowResolver.get(f"{self.repo_owner}/{self.repo_name}")
