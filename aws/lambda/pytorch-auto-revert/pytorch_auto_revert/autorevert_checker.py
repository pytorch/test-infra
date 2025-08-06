"""
Autorevert pattern detection for PyTorch CI workflows.

Detects pattern where 2 recent commits have same failure and 1 older doesn't.
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .clickhouse_client_helper import CHCliFactory


@dataclass
class JobResult:
    """Job execution result with classification."""

    head_sha: str
    name: str
    conclusion: str
    status: str
    classification_rule: str
    workflow_created_at: datetime


@dataclass
class CommitJobs:
    """All jobs for a single commit."""

    head_sha: str
    created_at: datetime
    jobs: List[JobResult]

    @property
    def failed_jobs(self) -> List[JobResult]:
        """Jobs with failure conclusion and classification rule."""
        return [
            j for j in self.jobs if j.conclusion == "failure" and j.classification_rule
        ]

    @property
    def has_pending_jobs(self) -> bool:
        """Check if any jobs are still pending."""
        return any(j.status == "pending" for j in self.jobs)

    @property
    def job_base_names(self) -> Set[str]:
        if not hasattr(self, "_job_base_names"):
            self._job_base_names = self.get_job_base_names()
        return self._job_base_names

    def normalize_job_name(self, name: str) -> str:
        """Strip shard suffix from job name for matching."""
        # Remove patterns like ", 1, 1, " or ", 2, 3, " from job names
        return re.sub(r", \d+, \d+, ", ", ", name)

    def get_job_base_names(self) -> Set[str]:
        """Get normalized job names (without shard info)."""
        return {self.normalize_job_name(j.name) for j in self.jobs}


class AutorevertPatternChecker:
    """Detects autorevert patterns in workflow job failures."""

    def __init__(self, workflow_names: List[str] = None, lookback_hours: int = 48):
        self.workflow_names = workflow_names or []
        self.lookback_hours = lookback_hours
        self._workflow_commits_cache: Dict[str, List[CommitJobs]] = {}
        self._commit_history = None

    def get_workflow_commits(self, workflow_name: str) -> List[CommitJobs]:
        """Get workflow commits for a specific workflow, fetching if needed. From newer to older"""
        if workflow_name not in self._workflow_commits_cache:
            self._fetch_workflow_data()
        return self._workflow_commits_cache.get(workflow_name, [])

    @property
    def workflow_commits(self) -> List[CommitJobs]:
        """Get workflow commits for the first workflow (backward compatibility)."""
        if self.workflow_names:
            return self.get_workflow_commits(self.workflow_names[0])
        return []

    @property
    def commit_history(self) -> List[Dict]:
        """Get commit history, fetching if needed."""
        if self._commit_history is None:
            self._fetch_commit_history()
        return self._commit_history or []

    def _fetch_workflow_data(self):
        """Fetch workflow job data from ClickHouse for all workflows in batch. From newer to older"""
        if not self.workflow_names:
            return

        lookback_time = datetime.now() - timedelta(hours=self.lookback_hours)

        print(
            f"Fetching workflow data for {len(self.workflow_names)} workflows since {lookback_time.isoformat()}..."
        )

        query = """
        SELECT
            workflow_name,
            head_sha,
            name,
            conclusion,
            status,
            torchci_classification.rule AS classification_rule,
            created_at AS workflow_created_at
        FROM
            workflow_job FINAL
        WHERE
            workflow_name IN {workflow_names:Array(String)}
            AND head_branch = 'main'
            AND created_at >= {lookback_time:DateTime}
            AND dynamoKey LIKE 'pytorch/pytorch/%'
            AND workflow_event != 'workflow_dispatch'  -- Exclude restart jobs
        ORDER BY
            workflow_name, workflow_created_at DESC, head_sha, name
        """

        result = CHCliFactory().client.query(
            query,
            parameters={
                "workflow_names": self.workflow_names,
                "lookback_time": lookback_time,
            },
        )

        # Group by workflow and commit SHA
        workflow_commits_data = {}
        for row in result.result_rows:
            (
                workflow_name,
                head_sha,
                name,
                conclusion,
                status,
                classification_rule,
                created_at,
            ) = row

            if workflow_name not in workflow_commits_data:
                workflow_commits_data[workflow_name] = {}

            if head_sha not in workflow_commits_data[workflow_name]:
                workflow_commits_data[workflow_name][head_sha] = CommitJobs(
                    head_sha=head_sha, created_at=created_at, jobs=[]
                )

            workflow_commits_data[workflow_name][head_sha].jobs.append(
                JobResult(
                    head_sha=head_sha,
                    name=name,
                    conclusion=conclusion,
                    status=status,
                    classification_rule=classification_rule or "",
                    workflow_created_at=created_at,
                )
            )

        # Sort and cache results per workflow
        for workflow_name, commits_data in workflow_commits_data.items():
            print(
                f"Found {len(commits_data)} commits with job data for workflow '{workflow_name}'"
            )
            self._workflow_commits_cache[workflow_name] = sorted(
                commits_data.values(), key=lambda c: c.created_at, reverse=True
            )

        # Initialize empty lists for workflows with no data
        for workflow_name in self.workflow_names:
            if workflow_name not in self._workflow_commits_cache:
                self._workflow_commits_cache[workflow_name] = []

    def _fetch_commit_history(self):
        """Fetch commit history from push table."""
        lookback_time = datetime.now() - timedelta(hours=self.lookback_hours)

        query = """
        SELECT DISTINCT
            head_commit.id as sha,
            head_commit.message as message,
            head_commit.timestamp as timestamp
        FROM default.push
        WHERE head_commit.timestamp >= {lookback_time:DateTime}
          AND ref = 'refs/heads/main'
        ORDER BY head_commit.timestamp DESC
        """

        result = CHCliFactory().client.query(
            query, parameters={"lookback_time": lookback_time}
        )

        self._commit_history = [
            {"sha": row[0], "message": row[1], "timestamp": row[2]}
            for row in result.result_rows
        ]

    def _find_last_commit_with_job(
        self, commits: Iterable[CommitJobs], job_name: str
    ) -> Optional[Tuple[CommitJobs, List[JobResult]]]:
        """
        Find the last commit in the iterable that has a job with the specified name.

        Args:
            commits: Iterable of CommitJobs to search
            job_name: The job name to look for

        Returns:
            The last CommitJobs object that contains the specified job, or None if not found
        """
        job_results = []
        for commit in commits:
            for job in commit.jobs:
                if job.name.split("(")[0] == job_name:  # Normalize job name
                    job_results.append(job)
            if job_results:
                return (
                    commit,
                    job_results,
                )
        return None, None

    def detect_autorevert_pattern_workflow(self, workflow_name: str) -> List[Dict]:
        """
        Detect all autorevert patterns in commit job data for a specific workflow.

        Pattern: 3 consecutive commits where:
        - 2 newer commits have same exact failure classification
        - 1 older commit doesn't have this failure but has matching jobs
        - All commits have signal (jobs present) and no pending jobs in oldest

        Args:
            workflow_name: The workflow to analyze

        Returns:
            List of all detected patterns
        """
        commits = self.get_workflow_commits(workflow_name)
        if len(commits) < 3:
            return []

        patterns = []

        for i in range(1, len(commits) - 1):
            suspected_commit1 = commits[i]  # The commit we want to check for failure

            if suspected_commit1.has_pending_jobs:
                continue

            suspected_failures = {
                (
                    j.classification_rule,
                    j.name.split("(")[0],
                )
                for j in suspected_commit1.failed_jobs
            }

            # Map to track newer commits for each failure
            failure_to_newer_commit = {}

            for (
                suspected_failure_class_rule,
                suspected_failure_job_name,
            ) in suspected_failures:
                newer_commit_same_job, newer_same_jobs = (
                    self._find_last_commit_with_job(
                        (commits[j] for j in range(i - 1, -1, -1)),
                        suspected_failure_job_name,
                    )
                )
                if not newer_commit_same_job or not newer_same_jobs:
                    # No newer commit with the same job found
                    continue

                if any(
                    j.classification_rule == suspected_failure_class_rule
                    for j in newer_same_jobs
                ):
                    # The newer commit has the same job failing
                    failure_key = (
                        suspected_failure_class_rule,
                        suspected_failure_job_name,
                    )
                    failure_to_newer_commit[failure_key] = newer_commit_same_job

            if not failure_to_newer_commit:
                continue

            for (
                failure_rule,
                job_name,
            ), newer_commit in failure_to_newer_commit.items():
                last_commit_with_same_job, last_same_jobs = (
                    self._find_last_commit_with_job(
                        (commits[j] for j in range(i + 1, len(commits))), job_name
                    )
                )

                if not last_commit_with_same_job or not last_same_jobs:
                    # No older commit with the same job found
                    continue

                if any(
                    j.classification_rule == suspected_failure_class_rule
                    for j in last_same_jobs
                ):
                    # The older commit has the same job failing with same rule
                    continue

                patterns.append(
                    {
                        "pattern_detected": True,
                        "workflow_name": workflow_name,
                        "failure_rule": failure_rule,
                        "newer_commits": [
                            newer_commit.head_sha,
                            suspected_commit1.head_sha,
                        ],
                        "older_commit": last_commit_with_same_job.head_sha,
                        "failed_job_names": [j.name for j in last_same_jobs],
                        "older_job_coverage": [],
                    }
                )
                break

        return patterns

    def detect_autorevert_pattern(self) -> List[Dict]:
        """
        Detect all autorevert patterns across all configured workflows.

        When the same commits are detected across multiple workflows, the pattern
        is kept once with the first workflow, and other workflows are added to
        an 'additional_workflows' field.

        Returns:
            List of all detected patterns from all workflows (deduplicated)
        """
        all_patterns = []
        seen_commit_pairs = {}  # Map of (commit1, commit2) -> pattern index

        for workflow_name in self.workflow_names:
            patterns = self.detect_autorevert_pattern_workflow(workflow_name)

            for pattern in patterns:
                # Create a key from the two newer commits (order-independent)
                commit_pair = tuple(sorted(pattern["newer_commits"]))

                if commit_pair in seen_commit_pairs:
                    # Add this workflow to the existing pattern's additional_workflows
                    pattern_idx = seen_commit_pairs[commit_pair]
                    existing_pattern = all_patterns[pattern_idx]

                    if "additional_workflows" not in existing_pattern:
                        existing_pattern["additional_workflows"] = []

                    existing_pattern["additional_workflows"].append(
                        {
                            "workflow_name": workflow_name,
                            "failure_rule": pattern["failure_rule"],
                        }
                    )
                else:
                    # First time seeing this commit pair
                    seen_commit_pairs[commit_pair] = len(all_patterns)
                    all_patterns.append(pattern)

        return all_patterns

    def get_commits_reverted(self) -> Set[str]:
        """
        Get all commits that were reverted within the lookback window.

        Returns:
            List of revert information dictionaries
        """
        reverted_commits = set()
        for commit in self.commit_history:
            revert_info = self.is_commit_reverted(commit["sha"])
            if revert_info:
                reverted_commits.add(commit["sha"])
        return reverted_commits

    def is_commit_reverted(self, target_commit_sha: str) -> Optional[Dict]:
        """
        Check if a commit was reverted within the lookback window.

        Args:
            target_commit_sha: The commit to check for reverting

        Returns:
            Dict with revert information if found, None otherwise
        """
        commits = self.commit_history
        target_time = None

        # Find target commit timestamp
        for commit in commits:
            if commit["sha"] == target_commit_sha:
                target_time = commit["timestamp"]
                break

        if not target_time:
            return None  # Target commit not found

        # Look for revert commits after target commit
        for commit in commits:
            commit_time = commit["timestamp"]

            # Only consider commits after target
            if commit_time <= target_time:
                continue

            message = commit["message"]

            # Check for revert pattern
            if (
                message.startswith('Revert "')
                and f"This reverts commit {target_commit_sha}" in message
            ):
                return {
                    "reverted": True,
                    "revert_sha": commit["sha"],
                    "revert_message": message,
                    "revert_timestamp": commit_time,
                    "hours_after_target": (commit_time - target_time).total_seconds()
                    / 3600,
                }

        return None  # No revert found

    def extract_revert_categories_batch(self, messages: List[str]) -> Dict[str, str]:
        """
        Extract categories from multiple revert commit messages in a single batch query.

        Categories are specified with -c flag like:
        - nosignal
        - ignoredsignal
        - landrace
        - weird
        - ghfirst

        Args:
            messages: List of revert commit messages

        Returns:
            Dict mapping message to category
        """
        # Extract all comment IDs
        comment_ids = []
        message_to_comment_id = {}

        for message in messages:
            comment_match = re.search(r"#issuecomment-(\d+)", message)
            if comment_match:
                comment_id = int(comment_match.group(1))
                comment_ids.append(comment_id)
                message_to_comment_id[message] = comment_id

        # Batch query for all comment bodies
        comment_id_to_category = {}
        if comment_ids:
            try:
                query = """
                SELECT id, body
                FROM issue_comment
                WHERE id IN {comment_ids:Array(Int64)}
                """
                result = CHCliFactory().client.query(
                    query, parameters={"comment_ids": comment_ids}
                )

                for row in result.result_rows:
                    comment_id, body = row
                    # Look for -c flag in comment body
                    match = re.search(r"-c\s+(\w+)", body)
                    if match:
                        category = match.group(1).lower()
                        if category in [
                            "nosignal",
                            "ignoredsignal",
                            "landrace",
                            "weird",
                            "ghfirst",
                        ]:
                            comment_id_to_category[comment_id] = category
            except Exception:
                # If query fails, continue without error
                pass

        # Map messages to categories
        result = {}
        for message in messages:
            comment_id = message_to_comment_id.get(message)
            if comment_id and comment_id in comment_id_to_category:
                result[message] = comment_id_to_category[comment_id]
            else:
                result[message] = "uncategorized"

        return result

    def get_commits_reverted_with_info(self) -> Dict[str, Dict]:
        """
        Get all commits that were reverted with detailed information including categories.

        Returns:
            Dict mapping commit SHA to revert information with category
        """
        reverted_commits = {}
        revert_messages = []

        # First pass: collect all reverted commits and their messages
        for commit in self.commit_history:
            revert_info = self.is_commit_reverted(commit["sha"])
            if revert_info:
                reverted_commits[commit["sha"]] = revert_info
                revert_messages.append(revert_info["revert_message"])

        # Batch extract categories
        if revert_messages:
            message_to_category = self.extract_revert_categories_batch(revert_messages)

            # Update revert info with categories
            for _, info in reverted_commits.items():
                info["category"] = message_to_category.get(
                    info["revert_message"], "uncategorized"
                )

        return reverted_commits
