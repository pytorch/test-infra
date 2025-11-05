from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from functools import cached_property
from typing import List, NewType, Set

from .utils import RestartAction, RevertAction


# Default classification rules that indicate test failures.
DEFAULT_TEST_RULES: Set[str] = {
    "pytest failure",
    "Python unittest failure",
}

# Stronger typing for ids (type-checker only; runtime is still int/str)
WfRunId = NewType("WfRunId", int)
RunAttempt = NewType("RunAttempt", int)
JobId = NewType("JobId", int)
Sha = NewType("Sha", str)
WorkflowName = NewType("WorkflowName", str)
JobName = NewType("JobName", str)
JobBaseName = NewType("JobBaseName", str)
TestId = NewType("TestId", str)


# Shared run-scoped context used across integration, actions, and logging


@dataclass(frozen=True)
class RunContext:
    lookback_hours: int
    notify_issue_number: int
    repo_full_name: str
    restart_action: RestartAction
    revert_action: RevertAction
    ts: datetime
    workflows: List[str]


# Represents a job row from the jobs table in ClickHouse
@dataclass(frozen=True)
class JobRow:
    head_sha: Sha
    workflow_name: WorkflowName
    wf_run_id: WfRunId
    job_id: JobId
    run_attempt: RunAttempt
    name: JobName
    status: str
    conclusion: str
    started_at: datetime
    created_at: datetime
    rule: str

    @cached_property
    def base_name(self) -> JobBaseName:
        """Normalize job name to a stable base for matching across commits.

        - Drop any trailing parenthetical qualifiers (e.g., "(rocm)", shard notes)
        - Strip common shard suffixes like ", 1, 1, " used in CI naming
        - Collapse redundant whitespace
        """
        # Drop any trailing parenthetical qualifier
        base = re.sub(r"\s*\(.*\)$", "", self.name)
        # Remove patterns like ", 1, 1, " or ", 2, 3, " from job names
        base = re.sub(r", \d+, \d+, ", ", ", base)
        # Collapse multiple spaces
        base = re.sub(r"\s+", " ", base).strip()
        return JobBaseName(base)

    # ---- Convenience properties for verdicts/status ----
    #
    # Notes:
    #
    # - Table: default.workflow_job has status in {'completed','in_progress','queued'} and conclusion
    # in {'', 'success', 'failure', 'cancelled', 'skipped'}.
    #
    #  - Column conclusion_kg (alias) maps keep-going cases to 'failure' when conclusion=''
    #  and there is a temp classification.
    #
    #  - Some in_progress jobs already have conclusion_kg='failure' due to keep-going detection;
    # is_failure True while is_pending True.

    @cached_property
    def _status_l(self) -> str:
        return (self.status or "").lower()

    @cached_property
    def _conclusion_l(self) -> str:
        return (self.conclusion or "").lower()

    @property
    def is_completed(self) -> bool:
        return self._status_l == "completed"

    @property
    def is_cancelled(self) -> bool:
        return self._conclusion_l == "cancelled"

    @property
    def is_failure(self) -> bool:
        # conclusion is already KG-adjusted in the datasource
        return self._conclusion_l == "failure"

    @property
    def is_success(self) -> bool:
        return self.is_completed and self._conclusion_l == "success"

    @property
    def is_pending(self) -> bool:
        # Pending if not completed or conclusion is empty (keep-going)
        return (not self.is_completed) or (self._conclusion_l == "")

    @cached_property
    def is_test_failure(self) -> bool:
        """True if this job is classified as a test failure."""

        return self.is_failure and (self.rule in DEFAULT_TEST_RULES)


# Represents a test verdict row from the tests.all_test_runs table in ClickHouse
@dataclass(frozen=True)
class TestRow:
    job_id: JobId
    wf_run_id: WfRunId
    workflow_run_attempt: RunAttempt
    file: str
    classname: str
    name: str
    failure_runs: int  # count of failed test runs
    success_runs: int  # count of successful test runs

    @property
    def test_id(self) -> TestId:
        # file::name is a stable, readable key; classname can be added if needed
        test_key = f"{self.file}::{self.name}" if self.file else self.name
        return TestId(test_key)
