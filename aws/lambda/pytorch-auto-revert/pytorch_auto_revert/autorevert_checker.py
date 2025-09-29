"""
Autorevert pattern detection for PyTorch CI workflows.

Detects pattern where 2 recent commits have same failure and 1 older doesn't.
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import cached_property
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .clickhouse_client_helper import CHCliFactory
from .utils import RetryWithBackoff


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
        """Check if any jobs are not yet completed (queued/in_progress)."""
        return any(j.status != "completed" for j in self.jobs)

    @cached_property
    def job_base_names(self) -> Set[str]:
        return self.get_job_base_names()

    def jobs_with_base_name(self, job_base_name: str) -> List[JobResult]:
        """Get all jobs with a specific normalized base name."""
        return [
            j for j in self.jobs if self.normalize_job_name(j.name) == job_base_name
        ]

    def normalize_job_name(self, name: str) -> str:
        """Normalize job name to a stable base for matching across commits.

        - Drop any trailing parenthetical qualifiers (e.g., "(rocm)", shard notes)
        - Strip common shard suffixes like ", 1, 1, " used in CI naming
        - Collapse redundant whitespace
        """
        # Drop any trailing parenthetical qualifier
        base = re.sub(r"\s*\(.*\)$", "", name)
        # Remove patterns like ", 1, 1, " or ", 2, 3, " from job names
        base = re.sub(r", \d+, \d+, ", ", ", base)
        # Collapse multiple spaces
        base = re.sub(r"\s+", " ", base).strip()
        return base

    def get_job_base_names(self) -> Set[str]:
        """Get normalized job names (without shard info)."""
        return {self.normalize_job_name(j.name) for j in self.jobs}


class AutorevertPatternChecker:
    """Detects autorevert patterns in workflow job failures."""

    def __init__(
        self,
        workflow_names: List[str] = None,
        lookback_hours: int = 48,
        ignore_classification_rules: Set[str] = None,
    ):
        self.workflow_names = workflow_names or []
        self.lookback_hours = lookback_hours
        self._workflow_commits_cache: Dict[str, List[CommitJobs]] = {}
        self._ignore_classification_rules = ignore_classification_rules or set()

    def get_workflow_commits(self, workflow_name: str) -> List[CommitJobs]:
        """Get workflow commits for a specific workflow, fetching if needed. From newer to older"""
        if workflow_name not in self._workflow_commits_cache:
            self._fetch_workflow_data()
        return self._workflow_commits_cache.get(workflow_name, [])

    @cached_property
    def workflow_commits(self) -> List[CommitJobs]:
        """Get workflow commits for the first workflow (backward compatibility)."""
        if self.workflow_names:
            return self.get_workflow_commits(self.workflow_names[0])
        return []

    @cached_property
    def commit_history(self) -> List[Dict]:
        return self._fetch_commit_history()

    @cached_property
    def commits_reverted(self) -> Set[str]:
        return self._get_commits_reverted()

    @cached_property
    def commits_reverted_with_info(self) -> Dict[str, Dict]:
        return self._get_commits_reverted_with_info()

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
                wf.workflow_name,
                wf.head_sha,
                wf.name,
                wf.conclusion,
                wf.status,
                wf.torchci_classification.rule AS classification_rule,
                wf.created_at AS workflow_created_at
            FROM workflow_job AS wf FINAL
            INNER JOIN (
                -- Deduplicate pushes by head_sha using group+max,
                -- keeping the most recent timestamp
                -- this is faster than using distinct
                SELECT
                    head_commit.id as sha,
                    max(head_commit.timestamp) as timestamp
                FROM default.push
                WHERE head_commit.timestamp >= {lookback_time:DateTime}
                AND ref = 'refs/heads/main'
                GROUP BY sha
            ) AS push_dedup ON wf.head_sha = push_dedup.sha
            WHERE
                wf.workflow_name IN {workflow_names:Array(String)}
                AND wf.workflow_event != 'workflow_dispatch'
                AND wf.head_branch = 'main'
                -- this timestamp should always be bigger than push_dedup.timestamp
                -- it is just a optimization as this column is indexed
                AND wf.created_at >= {lookback_time:DateTime}
                AND wf.dynamoKey LIKE 'pytorch/pytorch/%'
                AND (wf.name NOT LIKE '%mem_leak_check%' AND wf.name NOT LIKE '%rerun_disabled_tests%')
            ORDER BY
                wf.workflow_name, push_dedup.timestamp DESC, wf.head_sha, wf.name
        """

        for attempt in RetryWithBackoff():
            with attempt:
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
            SELECT
                head_commit.id as sha,
                head_commit.message as message,
                max(head_commit.timestamp) as timestamp
            FROM default.push
            WHERE head_commit.timestamp >= {lookback_time:DateTime}
            AND ref = 'refs/heads/main'
            GROUP BY sha, message
            ORDER BY timestamp DESC
        """

        for attempt in RetryWithBackoff():
            with attempt:
                result = CHCliFactory().client.query(
                    query, parameters={"lookback_time": lookback_time}
                )

                return [
                    {"sha": row[0], "message": row[1], "timestamp": row[2]}
                    for row in result.result_rows
                ]

    def _find_last_commit_with_job(
        self, commits: Iterable[CommitJobs], job_name: str
    ) -> Optional[Tuple[CommitJobs, List[JobResult]]]:
        """
        Find the first commit (in the provided iteration order) that has a job with the specified name.

        Args:
            commits: Iterable of CommitJobs to search
            job_name: The job name to look for

        Returns:
            The first CommitJobs object (per the iterable's order) that contains the specified job, or None if not found
        """
        job_results = []
        for commit in commits:
            for job in commit.jobs:
                if commit.normalize_job_name(job.name) == job_name:
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
        # Commits are ordered newest -> older for this workflow
        commits = self.get_workflow_commits(workflow_name)
        if len(commits) < 3:
            return []

        patterns = []

        # Slide a window centered at the suspected failing commit (i)
        # We require: a newer commit with the same failure (i-1..0) and an older baseline (i+1..end)
        for i in range(1, len(commits) - 1):
            suspected_commit1 = commits[i]

            # Extract unique (classification_rule, normalized job) pairs for failing jobs on the suspected commit
            suspected_failures = {
                (
                    j.classification_rule,
                    suspected_commit1.normalize_job_name(j.name),
                )
                for j in suspected_commit1.failed_jobs
            }

            # Map failure -> the nearest newer commit where the same job failed with the same rule
            failure_to_newer_commit = {}

            for (
                suspected_failure_class_rule,
                suspected_failure_job_name,
            ) in suspected_failures:
                if suspected_failure_class_rule in self._ignore_classification_rules:
                    # Skip ignored classification rules
                    continue

                # Find the closest newer commit that ran this exact normalized job name
                newer_commit_same_job, newer_same_jobs = (
                    self._find_last_commit_with_job(
                        (commits[j] for j in range(i - 1, -1, -1)),
                        suspected_failure_job_name,
                    )
                )
                if not newer_commit_same_job or not newer_same_jobs:
                    # No newer commit with the same job found
                    continue

                if (
                    newer_commit_same_job
                    and newer_same_jobs
                    and any(
                        j.classification_rule == suspected_failure_class_rule
                        and j.conclusion == "failure"
                        for j in newer_same_jobs
                    )
                ):
                    # The newer commit has the same failure on the same job
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
                # Find the first older commit that ran the same normalized job name
                last_commit_with_same_job, last_same_jobs = (
                    self._find_last_commit_with_job(
                        (commits[j] for j in range(i + 1, len(commits))), job_name
                    )
                )

                if not last_commit_with_same_job or not last_same_jobs:
                    # No older commit with same normalized job name found
                    continue

                # Ensure the oldest commit has stable signal for the jobs we care about (no running jobs)
                if any(j.status != "completed" for j in last_same_jobs):
                    continue

                if any(
                    j.classification_rule == failure_rule and j.conclusion == "failure"
                    for j in last_same_jobs
                ):
                    # Baseline already exhibits the same failure on this job -> not a commit-caused regression
                    continue

                # Record the detected pattern: (newer_fail, suspected_fail) contrasted against a clean baseline
                patterns.append(
                    {
                        "pattern_detected": True,
                        "workflow_name": workflow_name,
                        "failure_rule": failure_rule,
                        "job_name_base": job_name,
                        "newer_commits": [
                            newer_commit.head_sha,
                            suspected_commit1.head_sha,
                        ],
                        "older_commit": last_commit_with_same_job.head_sha,
                        "failed_job_names": [
                            j.name
                            for j in suspected_commit1.failed_jobs
                            if j.classification_rule == failure_rule
                        ][:10],
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

    def _fetch_single_commit_jobs(
        self,
        workflow_name: str,
        head_sha: str,
        restarted_only: bool = False,
    ) -> Optional[CommitJobs]:
        """Fetch jobs for a single workflow+commit, optionally only restarted runs.

        Groups all jobs by head_sha (assumes at most one restart dispatch of interest).
        Returns CommitJobs or None if no jobs found in lookback window.
        """
        lookback_time = datetime.now() - timedelta(hours=self.lookback_hours)

        where_event = (
            "workflow_event = {we:String} AND head_branch LIKE {hb:String}"
            if restarted_only
            else "workflow_event != {we:String} AND head_branch = {hb:String}"
        )

        query = f"""
        SELECT
            head_sha,
            name,
            conclusion,
            status,
            torchci_classification.rule AS classification_rule,
            created_at AS workflow_created_at
        FROM workflow_job FINAL
        WHERE workflow_name = {{workflow_name:String}}
          AND head_sha = {{head_sha:String}}
          AND {where_event}
          AND created_at >= {{lookback_time:DateTime}}
          AND dynamoKey LIKE 'pytorch/pytorch/%'
        ORDER BY workflow_created_at DESC, name
        """

        hb = "trunk/%" if restarted_only else "main"
        we = "workflow_dispatch" if restarted_only else "workflow_dispatch"
        # Note: for non-restarted we exclude workflow_dispatch via != in WHERE above

        for attempt in RetryWithBackoff():
            with attempt:
                result = CHCliFactory().client.query(
                    query,
                    parameters={
                        "workflow_name": workflow_name,
                        "head_sha": head_sha,
                        "we": we,
                        "hb": hb,
                        "lookback_time": lookback_time,
                    },
                )

                rows = list(result.result_rows)
        if not rows:
            return None

        # Use the newest created_at among returned rows as the commit's created_at marker
        latest_created = max(r[5] for r in rows)
        cj = CommitJobs(head_sha=head_sha, created_at=latest_created, jobs=[])
        for row in rows:
            _, name, conclusion, status, classification_rule, created_at = row
            cj.jobs.append(
                JobResult(
                    head_sha=head_sha,
                    name=name,
                    conclusion=conclusion,
                    status=status,
                    classification_rule=classification_rule or "",
                    workflow_created_at=created_at,
                )
            )
        return cj

    def confirm_commit_caused_failure_on_restarted(self, pattern: Dict) -> bool:
        """Confirm commit-caused failure using restarted runs.

        Requires that:
        - first failing commit's restarted run has the same failure classification for the job
        - previous commit's restarted run does NOT have that failure classification for the job
        - both restarted runs have no pending jobs
        """
        workflow_name = pattern["workflow_name"]
        job_base = pattern.get("job_name_base")
        failure_rule = pattern["failure_rule"]
        first_failing = pattern["newer_commits"][1]
        previous_commit = pattern["older_commit"]

        # Fetch restarted jobs for first failing and previous commits
        failing_commit_jobs = self._fetch_single_commit_jobs(
            workflow_name, first_failing, restarted_only=True
        )
        prev_commit_jobs = self._fetch_single_commit_jobs(
            workflow_name, previous_commit, restarted_only=True
        )
        if not failing_commit_jobs or not prev_commit_jobs:
            return False

        failing_suspected_jobs = failing_commit_jobs.jobs_with_base_name(job_base)
        prev_suspected_jobs = prev_commit_jobs.jobs_with_base_name(job_base)
        if any(j.status != "completed" for j in prev_suspected_jobs):
            # Previous commit has pending jobs, cannot confirm
            return False

        def has_rule(jobs: Iterable[JobResult], rule: str) -> bool:
            return any(
                j.classification_rule == rule and j.conclusion == "failure"
                for j in jobs
            )

        # Commit-caused if failing commit reproduces, previous does not
        return has_rule(failing_suspected_jobs, failure_rule) and not has_rule(
            prev_suspected_jobs, failure_rule
        )

    def _get_commits_reverted(self) -> Set[str]:
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

                for attempt in RetryWithBackoff():
                    with attempt:
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

    def _get_commits_reverted_with_info(self) -> Dict[str, Dict]:
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
