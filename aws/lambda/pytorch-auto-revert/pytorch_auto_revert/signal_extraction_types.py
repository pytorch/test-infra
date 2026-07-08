from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from functools import cached_property
from typing import List, NewType, Set

from .utils import AdvisorAction, RestartAction, RevertAction


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
    advisor_action: AdvisorAction
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
    # GitHub Actions trigger of the run this job belongs to (push / schedule /
    # workflow_dispatch / ...). Default "" for callers that don't populate it
    # (treated as a natural run). Autorevert's own restarts are
    # `workflow_dispatch`; see `is_workflow_dispatch`.
    workflow_event: str = ""

    @cached_property
    def base_name(self) -> JobBaseName:
        """Normalize a job name to a stable signal key for matching across commits.

        PyTorch CI test jobs are named like::

            <env> / <step> (<config>, <shard_idx>, <num_shards>, <runner>[, <flags>])

        e.g. ``linux-jammy-cuda13.0-py3.10-gcc11 / test (pr_time_benchmarks, 1, 1, runner)``.
        The first token inside the parenthetical is the test *config*; the
        remaining tokens are volatile per-run metadata (shard index, shard
        count, runner label, and flags such as ``unstable`` /
        ``rerun_disabled_tests``).

        Normalization keeps the config so that distinct configs become distinct
        signals, while shards of the same config still aggregate together:

        1. **Config present** -- if any parenthetical contains a comma, its
           first token is the config and is preserved as ``(<config>)``. This
           stops a config (e.g. the ``pr_time_benchmarks`` perf gate) from being
           merged into -- and diluted by -- noisier sibling configs such as
           ``default`` / ``distributed`` under the same step.
        2. **No config** -- drop every parenthetical qualifier and group on the
           cleaned name.

        Each parenthetical group is stripped independently (not as a single
        greedy span), so a leading build-env qualifier like ``(3.12)`` does not
        swallow the trailing config parenthetical or the step label in between.

        DISCLAIMER: build-env qualifiers carried *outside* the config
        parenthetical -- notably the Python version in
        ``inductor-cpu-core-test (3.11|3.12|3.13)`` -- are dropped, so those
        variants intentionally collapse into a single signal. This is accepted
        for simplicity for now; revisit if one version proves independently
        flaky and reintroduces cross-variant mixing.
        """
        # Config = first token before the first comma inside any parenthetical.
        m = re.search(r"\(([^,()]+),", self.name)
        config = m.group(1).strip() if m else None
        # Drop all parenthetical groups (each stripped on its own, not greedily
        # spanning across multiple groups), then collapse whitespace.
        base = re.sub(r"\s*\([^()]*\)", "", self.name)
        base = re.sub(r"\s+", " ", base).strip()
        if config:
            base = f"{base} ({config})".strip()
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
    def is_skipped(self) -> bool:
        # Treated as "missing" by the aggregator (same as cancelled): the job
        # produced no signal-bearing outcome (e.g. `if:` gate, required-check
        # skip when an upstream dependency was cancelled/failed).
        return self._conclusion_l == "skipped"

    @property
    def is_workflow_dispatch(self) -> bool:
        # True when this run was triggered via the GitHub workflow_dispatch
        # API — which is how autorevert fires its own restarts. Such runs are
        # job/test-filtered, so a concluded dispatch run with no event for a
        # given test is NOT proof the test was absent (it may simply not have
        # been in the dispatch's test filter). They must not establish a
        # born-red baseline; see signal_extraction._build_test_signals.
        return self.workflow_event.lower() == "workflow_dispatch"

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
