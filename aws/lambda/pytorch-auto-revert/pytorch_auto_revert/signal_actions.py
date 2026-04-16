from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, FrozenSet, Iterable, List, Optional, Tuple, Union

import github

from .clickhouse_client_helper import CHCliFactory
from .github_client_helper import GHClientFactory
from .signal import (
    AutorevertPattern,
    DispatchAdvisor,
    Ineligible,
    RestartCommits,
    Signal,
)
from .signal_extraction_types import RunContext
from .utils import (
    build_job_pytorch_url,
    build_pytorch_hud_url,
    proper_workflow_create_dispatch,
    RestartAction,
    RetryWithBackoff,
    RevertAction,
)
from .workflow_checker import WorkflowRestartChecker


# Alias for outcomes produced by signal processing
SignalProcOutcome = Union[AutorevertPattern, RestartCommits, Ineligible]


class CommitPRSourceAction(Enum):
    MERGE = "merge"
    REVERT = "revert"


@dataclass(frozen=True)
class SignalMetadata:
    """Minimal identifying metadata for a Signal used in action provenance."""

    workflow_name: str
    key: str
    job_base_name: Optional[str] = None
    test_module: Optional[str] = None
    wf_run_id: Optional[int] = None
    job_id: Optional[int] = None
    advisor_summary: Optional[str] = None  # short AI advisor verdict summary


def _derive_job_filter(job_base_name: Optional[str]) -> Optional[str]:
    """Extract job display name for jobs-to-include filter.

    For jobs with " / " separator (e.g., "linux-jammy-cuda12.8 / test"),
    returns the prefix before the separator.

    For jobs without separator (e.g., "linux-jammy-py3.10-gcc11", "inductor-build"),
    returns the full job_base_name as the display name.

    Examples:
        "linux-jammy-cuda12.8 / test" -> "linux-jammy-cuda12.8"
        "linux-jammy-py3.10-gcc11"    -> "linux-jammy-py3.10-gcc11"
        "inductor-build"              -> "inductor-build"
        "job-filter"                  -> "job-filter"
    """
    if not job_base_name:
        return None
    if " / " in job_base_name:
        return job_base_name.split(" / ")[0].strip()
    return job_base_name.strip()


@dataclass(frozen=True)
class ActionGroup:
    """A coalesced action candidate built from one or more signals.

    - type: 'revert' | 'restart'
    - commit_sha: target commit
    - workflow_target: workflow to restart (restart only); None/'' for revert
    - sources: contributing signals (workflow_name, key, outcome)
    - jobs_to_include: job display names to filter for restart (empty = all jobs)
    - tests_to_include: test module paths to filter for restart (empty = all tests)
    """

    type: str  # 'revert' | 'restart'
    commit_sha: str
    workflow_target: str | None  # restart-only; None/'' for revert
    sources: List[SignalMetadata]
    jobs_to_include: FrozenSet[str] = frozenset()
    tests_to_include: FrozenSet[str] = frozenset()


class ActionLogger:
    """ClickHouse logger and query helper for v2 actions tables.

    Provides lightweight reads for dedup/caps checks and a single-row insert
    API that records grouped action provenance (source signals).
    """

    def __init__(self) -> None:
        # Intentionally avoid storing the client; call CHCliFactory().client inline per request.
        pass

    def prior_revert_exists(self, *, repo: str, commit_sha: str) -> bool:
        """Return True if a non-dry-run revert was already logged for commit_sha."""
        q = (
            "SELECT 1 FROM misc.autorevert_events_v2 "
            "WHERE repo = {repo:String} AND action = 'revert' "
            "AND commit_sha = {sha:String} AND dry_run = 0 LIMIT 1"
        )
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(q, {"repo": repo, "sha": commit_sha})
                return len(res.result_rows) > 0

    def prior_advisor_exists(
        self, *, repo: str, commit_sha: str, signal_key: str
    ) -> bool:
        """Return True if an advisor was already dispatched for this commit + signal."""
        q = (
            "SELECT 1 FROM misc.autorevert_events_v2 "
            "WHERE repo = {repo:String} AND action = 'advisor' "
            "AND commit_sha = {sha:String} "
            "AND has(source_signal_keys, {key:String}) "
            "AND dry_run = 0 LIMIT 1"
        )
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(
                    q, {"repo": repo, "sha": commit_sha, "key": signal_key}
                )
                return len(res.result_rows) > 0

    def advisor_count_for_commit(
        self, *, repo: str, commit_sha: str, workflow: str
    ) -> int:
        """Return total advisor dispatches for a (repo, commit, workflow)."""
        q = (
            "SELECT count() FROM misc.autorevert_events_v2 "
            "WHERE repo = {repo:String} AND action = 'advisor' "
            "AND commit_sha = {sha:String} "
            "AND has(workflows, {wf:String}) "
            "AND dry_run = 0"
        )
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(
                    q, {"repo": repo, "sha": commit_sha, "wf": workflow}
                )
                if res.result_rows:
                    return int(res.result_rows[0][0])
                return 0

    @dataclass(frozen=True)
    class RestartStats:
        total_restarts: int = 0
        has_success_within_window: bool = False
        failures_since_last_success: int = 0
        secs_since_last_failure: int = 0

    def restart_stats(
        self,
        *,
        repo: str,
        workflow: str,
        commit_sha: str,
        pacing: timedelta,
    ) -> RestartStats:
        """Return pacing/cap/backoff stats in one query."""
        q = (
            "WITH\n"
            "  rows AS (\n"
            "    SELECT ts, failed FROM misc.autorevert_events_v2\n"
            "    WHERE repo = {repo:String} AND action = 'restart' AND dry_run = 0\n"
            "      AND commit_sha = {sha:String} AND has(workflows, {wf:String})\n"
            "  ),\n"
            "  latest_success AS (\n"
            "    SELECT maxIf(ts, failed = 0) AS ts FROM rows\n"
            "  ),\n"
            "  base AS (\n"
            "    SELECT\n"
            "      count() AS total_restarts,\n"
            "      maxIf(ts, failed = 1) AS last_failure_ts,\n"
            "      (countIf(failed = 0 AND ts > (now() - toIntervalSecond({pacing_sec:UInt32}))) > 0) "
            "               AS has_success_within_window\n"
            "    FROM rows\n"
            "  )\n"
            "SELECT\n"
            "  total_restarts,\n"
            "  has_success_within_window,\n"
            "  (SELECT sumIf(1, failed = 1 AND ts > (SELECT ts FROM latest_success)) FROM rows) "
            "           AS failures_since_last_success,\n"
            "  toUInt32(now() - last_failure_ts) AS secs_since_last_failure\n"
            "FROM base"
        )
        params = {
            "repo": repo,
            "wf": workflow,
            "sha": commit_sha,
            "pacing_sec": max(0, int(pacing.total_seconds())),
        }
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(q, params)
                if not res.result_rows:
                    return ActionLogger.RestartStats()
                row = res.result_rows[0]
                return ActionLogger.RestartStats(
                    total_restarts=int(row[0]),
                    has_success_within_window=bool(row[1]),
                    failures_since_last_success=int(row[2]),
                    secs_since_last_failure=int(row[3]),
                )

    def insert_event(
        self,
        *,
        repo: str,
        ts: datetime,
        action: str,
        commit_sha: str,
        workflows: List[str],
        source_signal_keys: List[str],
        dry_run: bool,
        failed: bool,
        notes: str = "",
    ) -> None:
        """Insert a single grouped action row into misc.autorevert_events_v2."""
        cols = [
            "ts",
            "repo",
            "action",
            "commit_sha",
            "workflows",
            "source_signal_keys",
            "dry_run",
            "failed",
            "notes",
        ]
        data = [
            [
                ts,
                repo,
                action,
                commit_sha,
                workflows,
                source_signal_keys,
                1 if dry_run else 0,
                1 if failed else 0,
                notes or "",
            ]
        ]
        for attempt in RetryWithBackoff():
            with attempt:
                CHCliFactory().client.insert(
                    table="autorevert_events_v2",
                    data=data,
                    column_names=cols,
                    database="misc",
                )


class SignalActionProcessor:
    """Compute grouped actions from (Signal, Outcome) pairs and execute them.

    Responsibilities:
    - Group per-signal outcomes into coalesced ActionGroup items
    - Enforce ClickHouse-based dedup/caps
    - Dispatch restarts and log actions to v2 table
    """

    def __init__(self) -> None:
        self._logger = ActionLogger()
        self._restart = WorkflowRestartChecker()

    def group_actions(
        self, pairs: Iterable[Tuple[Signal, SignalProcOutcome]]
    ) -> List[ActionGroup]:
        """Coalesce (Signal, Outcome) pairs into revert/restart ActionGroup items.

        - Reverts are grouped by commit only
        - Restarts are grouped by (workflow_name, commit)
        """
        # Accumulate by action key
        revert_map: Dict[str, List[SignalMetadata]] = {}
        restart_map: Dict[tuple[str, str], List[SignalMetadata]] = {}

        for sig, outcome in pairs:
            # Extract fields for job/HUD links from AutorevertPattern
            wf_run_id = None
            job_id = None
            advisor_summary = None
            if isinstance(outcome, AutorevertPattern):
                wf_run_id = outcome.wf_run_id
                job_id = outcome.job_id
                if outcome.advisor_verdict is not None:
                    av = outcome.advisor_verdict
                    advisor_summary = (
                        f"AI advisor: {av.verdict.value} "
                        f"(confidence={av.confidence:.2f})"
                    )

            meta = SignalMetadata(
                workflow_name=sig.workflow_name,
                key=sig.key,
                job_base_name=sig.job_base_name,
                test_module=sig.test_module,
                wf_run_id=wf_run_id,
                job_id=job_id,
                advisor_summary=advisor_summary,
            )
            if isinstance(outcome, AutorevertPattern):
                sha = outcome.suspected_commit
                revert_map.setdefault(sha, []).append(meta)
            elif isinstance(outcome, RestartCommits):
                for sha in outcome.commit_shas:
                    k = (sig.workflow_name, sha)
                    restart_map.setdefault(k, []).append(meta)
            else:
                # Ineligible → no action
                continue

        groups: List[ActionGroup] = []
        for sha, sources in revert_map.items():
            groups.append(
                ActionGroup(
                    type="revert", commit_sha=sha, workflow_target=None, sources=sources
                )
            )
        for (wf, sha), sources in restart_map.items():
            jobs = [_derive_job_filter(src.job_base_name) for src in sources]

            groups.append(
                ActionGroup(
                    type="restart",
                    commit_sha=sha,
                    workflow_target=wf,
                    sources=sources,
                    jobs_to_include=frozenset(j for j in jobs if j is not None),
                    tests_to_include=frozenset(
                        src.test_module for src in sources if src.test_module
                    ),
                )
            )
        return groups

    def execute(self, group: ActionGroup, ctx: RunContext) -> bool:
        """Execute a single ActionGroup.

        Routes to the concrete executor. Returns True iff an action row was
        inserted (i.e., passed dedup/caps and, for restarts, dispatch attempted).
        """
        logging.info("[v2][action] preparing to execute %s", group)
        if group.type == "revert":
            return self.execute_revert(
                commit_sha=group.commit_sha, sources=group.sources, ctx=ctx
            )
        if group.type == "restart":
            assert group.workflow_target, "restart requires workflow_target"
            return self.execute_restart(
                workflow_target=group.workflow_target,
                commit_sha=group.commit_sha,
                sources=group.sources,
                ctx=ctx,
                jobs_to_include=group.jobs_to_include,
                tests_to_include=group.tests_to_include,
            )
        return False

    def execute_revert(
        self, *, commit_sha: str, sources: List[SignalMetadata], ctx: RunContext
    ) -> bool:
        """Record a revert intent if not previously logged for the commit."""
        if ctx.revert_action == RevertAction.SKIP:
            logging.debug(
                "[v2][action] revert for sha %s: skipping (ignored)", commit_sha[:8]
            )
            return False

        dry_run = not ctx.revert_action.side_effects

        if self._logger.prior_revert_exists(
            repo=ctx.repo_full_name, commit_sha=commit_sha
        ):
            logging.info(
                "[v2][action] revert for sha %s: skipping existing", commit_sha[:8]
            )
            return False

        if not dry_run:
            self._comment_issue_pr_revert(commit_sha, sources, ctx)

        self._logger.insert_event(
            repo=ctx.repo_full_name,
            ts=ctx.ts,
            action="revert",
            commit_sha=commit_sha,
            workflows=sorted({s.workflow_name for s in sources}),
            source_signal_keys=[s.key for s in sources],
            dry_run=dry_run,
            failed=False,
            notes="",
        )
        logging.info(
            "[v2][action] revert for sha %s: logged%s",
            commit_sha[:8],
            " (dry_run)" if dry_run else "",
        )
        return True

    def execute_restart(
        self,
        *,
        workflow_target: str,
        commit_sha: str,
        sources: List[SignalMetadata],
        ctx: RunContext,
        jobs_to_include: FrozenSet[str] = frozenset(),
        tests_to_include: FrozenSet[str] = frozenset(),
    ) -> bool:
        """Dispatch a workflow restart subject to pacing, cap, and backoff; always logs the event."""
        if ctx.restart_action == RestartAction.SKIP:
            logging.info(
                "[v2][action] restart for sha %s: skipping (ignored)", commit_sha[:8]
            )
            return False

        dry_run = not ctx.restart_action.side_effects

        pacing_window = timedelta(minutes=20)
        stats = self._logger.restart_stats(
            repo=ctx.repo_full_name,
            workflow=workflow_target,
            commit_sha=commit_sha,
            pacing=pacing_window,
        )
        if stats.has_success_within_window:
            logging.info(
                "[v2][action] restart for sha %s: skipping pacing (successful restart within %d sec)",
                commit_sha[:8],
                int(pacing_window.total_seconds()),
            )
            return False
        if stats.total_restarts >= 5:
            logging.info(
                "[v2][action] restart for sha %s: skipping cap (total=%d)",
                commit_sha[:8],
                stats.total_restarts,
            )
            return False
        fail_streak = stats.failures_since_last_success
        if fail_streak > 0:
            # Exponential backoff: 20min, 40min, ... capped at 60min
            required_wait_sec = min(1200 * (2 ** (fail_streak - 1)), 3600)
            if stats.secs_since_last_failure < required_wait_sec:
                logging.info(
                    "[v2][action] restart for sha %s: skipping backoff (streak=%d, wait=%dm)",
                    commit_sha[:8],
                    fail_streak,
                    int(required_wait_sec // 60),
                )
                return False

        # Build notes incrementally
        notes_parts: list[str] = []
        if jobs_to_include:
            notes_parts.append(f"jobs_filter={','.join(jobs_to_include)}")
        if tests_to_include:
            notes_parts.append(f"tests_filter={','.join(tests_to_include)}")

        ok = True
        if not dry_run:
            try:
                self._restart.restart_workflow(
                    workflow_target,
                    commit_sha,
                    jobs_to_include=jobs_to_include,
                    tests_to_include=tests_to_include,
                )
            except Exception as exc:
                ok = False
                notes_parts.append(str(exc) or repr(exc))
                logging.exception(
                    "[v2][action] restart for sha %s: exception while dispatching",
                    commit_sha[:8],
                )

        notes = "; ".join(notes_parts)

        self._logger.insert_event(
            repo=ctx.repo_full_name,
            ts=ctx.ts,
            action="restart",
            commit_sha=commit_sha,
            workflows=[workflow_target],
            source_signal_keys=[s.key for s in sources],
            dry_run=dry_run,
            failed=not ok,
            notes=notes,
        )
        if not dry_run and ok:
            logging.info("[v2][action] restart for sha %s: dispatched", commit_sha[:8])
        elif not dry_run:
            logging.info(
                "[v2][action] restart for sha %s: not dispatched (%s)",
                commit_sha[:8],
                notes or "",
            )
        else:
            logging.info(
                "[v2][action] restart for sha %s: logged (dry_run)", commit_sha[:8]
            )
        return True

    def dispatch_advisors(
        self,
        pairs: Iterable[Tuple[Signal, SignalProcOutcome]],
        ctx: RunContext,
    ) -> List[Dict[str, str]]:
        """Dispatch AI advisors for all eligible signals.

        Iterates (Signal, Outcome) pairs in shuffled order so that when the
        per-(workflow, commit) cap is reached, a representative subset of
        signals is evaluated rather than always the same alphabetical prefix.

        Returns a list of dispatch metadata dicts for state logging, one per
        successfully dispatched advisor.
        """
        import random

        from .utils import AdvisorAction

        if ctx.advisor_action == AdvisorAction.SKIP:
            return []

        # Collect eligible pairs, then shuffle for representative sampling
        eligible = []
        for sig, outcome in pairs:
            advisor = getattr(outcome, "advisor", None)
            if advisor is not None:
                eligible.append((sig, advisor))

        random.shuffle(eligible)

        dispatches: List[Dict[str, str]] = []
        for sig, advisor in eligible:
            if self.execute_advisor(signal=sig, dispatch_advisor=advisor, ctx=ctx):
                dispatches.append(
                    {
                        "signal_key": f"{sig.workflow_name}:{sig.key}",
                        "commit_sha": advisor.suspect_commit,
                        "workflow_name": sig.workflow_name,
                        "mode": str(ctx.advisor_action),
                    }
                )
        logging.info("[v2] Dispatched %d advisor(s)", len(dispatches))
        return dispatches

    def execute_advisor(
        self,
        *,
        signal: Signal,
        dispatch_advisor: "DispatchAdvisor",
        ctx: RunContext,
    ) -> bool:
        """Dispatch AI advisor workflow for a signal (shadow mode: fire-and-forget).

        Returns True if an event row was inserted (passed dedup).
        """
        from .utils import AdvisorAction

        if ctx.advisor_action == AdvisorAction.SKIP:
            return False

        commit_sha = dispatch_advisor.suspect_commit
        dry_run = not ctx.advisor_action.side_effects

        if self._logger.prior_advisor_exists(
            repo=ctx.repo_full_name,
            commit_sha=commit_sha,
            signal_key=signal.key,
        ):
            logging.info(
                "[v2][action] advisor for sha %s key=%s: skipping existing",
                commit_sha[:8],
                signal.key,
            )
            return False

        # Cap: max 8 advisor dispatches per (workflow, commit) to limit cost
        ADVISOR_CAP_PER_WORKFLOW_COMMIT = 8
        count = self._logger.advisor_count_for_commit(
            repo=ctx.repo_full_name,
            commit_sha=commit_sha,
            workflow=signal.workflow_name,
        )
        if count >= ADVISOR_CAP_PER_WORKFLOW_COMMIT:
            logging.info(
                "[v2][action] advisor for sha %s wf=%s: cap reached (%d/%d)",
                commit_sha[:8],
                signal.workflow_name,
                count,
                ADVISOR_CAP_PER_WORKFLOW_COMMIT,
            )
            return False

        # Find PR number for the suspect commit
        pr_number = 0
        try:
            result = self._find_pr_by_sha(commit_sha, ctx)
            if result is not None:
                _, pr = result
                pr_number = pr.number
        except Exception:
            logging.warning(
                "[v2][action] advisor: failed to find PR for sha %s",
                commit_sha[:8],
                exc_info=True,
            )

        # Build signal pattern JSON and write to /tmp for debugging
        signal_pattern_json = self._build_signal_pattern_json(
            signal=signal,
            dispatch_advisor=dispatch_advisor,
            repo_full_name=ctx.repo_full_name,
        )
        try:
            import json
            import os
            import tempfile

            tmp_dir = os.path.join(tempfile.gettempdir(), "advisor-patterns")
            os.makedirs(tmp_dir, exist_ok=True)
            safe_key = re.sub(r"[^\w\-.]", "_", signal.key)[:80]
            tmp_path = os.path.join(tmp_dir, f"{commit_sha[:8]}_{safe_key}.json")
            with open(tmp_path, "w") as f:
                # Pretty-print for human readability; dispatch uses compact form
                f.write(json.dumps(json.loads(signal_pattern_json), indent=2))
            logging.info("[v2][action] advisor signal pattern written to %s", tmp_path)
        except Exception:
            logging.debug(
                "[v2][action] advisor: failed to write signal pattern to tmp",
                exc_info=True,
            )

        ok = True
        notes = ""
        if not dry_run:
            try:
                gh_client = GHClientFactory().client
                repo = gh_client.get_repo(ctx.repo_full_name)
                workflow = repo.get_workflow("claude-autorevert-advisor.yml")
                proper_workflow_create_dispatch(
                    workflow,
                    ref="main",
                    inputs={
                        "suspect_commit": commit_sha,
                        "pr_number": str(pr_number),
                        "signal_pattern": signal_pattern_json,
                    },
                )
            except Exception as exc:
                ok = False
                notes = f"dispatch error: {exc}"
                logging.warning(  # noqa: G200
                    "[v2][action] advisor dispatch failed for sha %s: %s",
                    commit_sha[:8],
                    str(exc),
                )

        self._logger.insert_event(
            repo=ctx.repo_full_name,
            ts=ctx.ts,
            action="advisor",
            commit_sha=commit_sha,
            workflows=[signal.workflow_name],
            source_signal_keys=[signal.key],
            dry_run=dry_run,
            failed=not ok,
            notes=notes,
        )
        logging.info(
            "[v2][action] advisor for sha %s key=%s: %s",
            commit_sha[:8],
            signal.key,
            "dispatched"
            if (not dry_run and ok)
            else ("failed" if not ok else "logged (dry_run)"),
        )
        return True

    @staticmethod
    def _build_signal_pattern_json(
        *,
        signal: Signal,
        dispatch_advisor: "DispatchAdvisor",
        repo_full_name: str,
    ) -> str:
        """Build flattened signal pattern JSON for the advisor workflow.

        Dumps ALL commits from signal.commits with partition annotations,
        timestamps, and event details.
        """
        import json

        failed_set = set(dispatch_advisor.failed_commits)
        successful_set = set(dispatch_advisor.successful_commits)

        # Partition label descriptions
        LABEL_FAILED = (
            "failed: commits where this signal FAILS, "
            "at or after the suspect commit (newest first)"
        )
        LABEL_UNKNOWN = (
            "unknown: commits between failed and successful partitions "
            "with no resolved events (pending or missing data)"
        )
        LABEL_SUCCESSFUL = (
            "successful: baseline commits where this signal was GREEN "
            "before the suspect commit"
        )
        LABEL_PRIOR = (
            "prior: older commits before the successful baseline. "
            "Important: the signal may have been fixed and then failed again. "
            "Don't make assumptions just based on the presence of failures here."
        )

        def _fmt_ts(dt: Optional[datetime]) -> str:
            if dt is None:
                return ""
            return dt.strftime("%Y-%m-%d %H:%M:%S UTC")

        def _partition_label(sha: str) -> str:
            if sha in failed_set:
                return LABEL_FAILED
            if sha in successful_set:
                return LABEL_SUCCESSFUL
            # Check if between failed and successful (unknown)
            # Commits are newest→oldest; failed comes first, then unknown, then successful
            # If we've seen any successful but not failed, it's prior
            # Simple approach: if not in failed/successful, check ordering
            return LABEL_UNKNOWN

        # Build commit list — identify partition boundaries to distinguish unknown vs prior
        # Commits are newest→oldest. The partition order is: failed → unknown → successful → prior
        # After the last successful commit, everything is prior.
        last_successful_idx = -1
        for i, c in enumerate(signal.commits):
            if c.head_sha in successful_set:
                last_successful_idx = i

        # Cap: successful + prior commits combined should not exceed 12
        # to keep the JSON payload manageable. Trim oldest (prior) first.
        MAX_SUCCESSFUL_PLUS_PRIOR = 12
        successful_plus_prior_count = 0

        commits_json = []
        for i, commit in enumerate(signal.commits):
            sha = commit.head_sha

            if sha in failed_set:
                label = LABEL_FAILED
            elif sha in successful_set:
                label = LABEL_SUCCESSFUL
                successful_plus_prior_count += 1
            elif i > last_successful_idx and last_successful_idx >= 0:
                label = LABEL_PRIOR
                successful_plus_prior_count += 1
                if successful_plus_prior_count > MAX_SUCCESSFUL_PLUS_PRIOR:
                    continue  # trim oldest prior commits
            else:
                label = LABEL_UNKNOWN

            events_json = []
            for ev in commit.events:
                event_dict = {
                    "status": ev.status.value,
                    "job_name": ev.job_name or ev.name,
                    "job_id": ev.job_id,
                    "wf_run_id": ev.wf_run_id,
                    "run_attempt": ev.run_attempt,
                    "started_at": _fmt_ts(ev.started_at),
                    "ended_at": _fmt_ts(ev.ended_at),
                }
                if ev.job_id:
                    event_dict["url"] = (
                        f"https://github.com/{repo_full_name}/actions/runs/"
                        f"{ev.wf_run_id}/job/{ev.job_id}"
                    )
                    event_dict["log_url"] = (
                        f"https://ossci-raw-job-status.s3.amazonaws.com/log/{ev.job_id}"
                    )
                events_json.append(event_dict)

            commits_json.append(
                {
                    "sha": sha,
                    "timestamp": _fmt_ts(commit.timestamp),
                    "partition": label,
                    "is_suspect": sha == dispatch_advisor.suspect_commit,
                    "events": events_json,
                }
            )

        return json.dumps(
            {
                "signal_key": signal.key,
                "signal_source": signal.source.value if signal.source else "unknown",
                "workflow_name": signal.workflow_name,
                "job_base_name": signal.job_base_name,
                "commit_order": "newest_first",
                "suspect_commit": dispatch_advisor.suspect_commit,
                "commits": commits_json,
            }
        )

    def _commit_message_check_pr_is_revert(
        self, commit_message: str, ctx: RunContext
    ) -> Optional[int]:
        # Look for "Reverted #XXXXX" - indicates a revert action
        revert_matches = re.findall(
            f"Reverted https://github.com/{ctx.repo_full_name}/pull/(\\d+)",
            commit_message,
        )
        if revert_matches:
            pr_number = int(revert_matches[-1])
            return pr_number
        return None

    def _commit_message_check_pr_is_merge(
        self, commit_message: str, ctx: RunContext
    ) -> Optional[int]:
        # Look for "Pull Request resolved: #XXXXX" - indicates a merge action
        merge_matches = re.findall(
            f"Pull Request resolved: https://github.com/{ctx.repo_full_name}/pull/(\\d+)",
            commit_message,
        )
        if merge_matches:
            pr_number = int(merge_matches[-1])
            return pr_number
        return None

    def _find_pr_by_sha(
        self, commit_sha: str, ctx: RunContext
    ) -> Optional[Tuple[CommitPRSourceAction, github.PullRequest.PullRequest]]:
        """Find the PR that contains the given commit SHA on the main branch.

        Args:
            commit_sha: The commit SHA to search for
            ctx: The run context containing repo information

        Returns:
            Tuple of (action_type, PullRequest) if found, None otherwise
        """
        try:
            for attempt in RetryWithBackoff():
                with attempt:
                    gh_client = GHClientFactory().client
                    repo = gh_client.get_repo(ctx.repo_full_name)

                    # Get the commit to check its message
                    commit = repo.get_commit(commit_sha)
                    commit_message = commit.commit.message

            # First check: parse commit message for PR references
            # This is the most reliable way to determine the pytorchbot action
            # Use findall to get all matches and pick the last one (pytorchbot appends at the end)
            pr_number = self._commit_message_check_pr_is_revert(commit_message, ctx)
            if pr_number is not None:
                try:
                    for attempt in RetryWithBackoff():
                        with attempt:
                            pr = repo.get_pull(pr_number)
                    logging.info(
                        "[v2][action] Found reverted PR #%d from commit message for commit %s",
                        pr.number,
                        commit_sha[:8],
                    )
                    return (CommitPRSourceAction.REVERT, pr)
                except Exception as e:
                    logging.warning(  # noqa: G200
                        "[v2][action] Error fetching reverted PR #%d from commit message: %s",
                        pr_number,
                        str(e),
                    )

            pr_number = self._commit_message_check_pr_is_merge(commit_message, ctx)
            if pr_number is not None:
                try:
                    for attempt in RetryWithBackoff():
                        with attempt:
                            pr = repo.get_pull(pr_number)
                    logging.info(
                        "[v2][action] Found PR #%d from commit message for commit %s",
                        pr.number,
                        commit_sha[:8],
                    )
                    return (CommitPRSourceAction.MERGE, pr)
                except Exception as e:
                    logging.warning(  # noqa: G200
                        "[v2][action] Error fetching PR #%d from commit message: %s",
                        pr_number,
                        str(e),
                    )

            # Second check: GitHub's API for associated pull requests
            # Default to MERGE action if we find a PR this way
            for attempt in RetryWithBackoff():
                with attempt:
                    prs = commit.get_pulls()

                    for pr in prs:
                        # Check if this PR targets main branch
                        if pr.base.ref == "main":
                            logging.info(
                                "[v2][action] Found PR #%d associated with commit %s",
                                pr.number,
                                commit_sha[:8],
                            )
                            return (CommitPRSourceAction.MERGE, pr)

            # Third check: search API fallback
            # Default to MERGE action if we find a PR this way
            for attempt in RetryWithBackoff():
                with attempt:
                    search_query = (
                        f"{commit_sha} repo:{ctx.repo_full_name} is:pr is:closed"
                    )
                    search_results = gh_client.search_issues(search_query)

                    for issue in search_results:
                        pr = repo.get_pull(issue.number)
                        if pr.base.ref == "main":
                            logging.info(
                                "[v2][action] Found PR #%d via search for commit %s",
                                pr.number,
                                commit_sha[:8],
                            )
                            return (CommitPRSourceAction.MERGE, pr)

            logging.warning(
                "[v2][action] No PR found for commit %s on main branch", commit_sha[:8]
            )
            return None

        except Exception as e:
            logging.error(  # noqa: G200
                "[v2][action] Error finding PR for commit %s: %s",
                commit_sha[:8],
                str(e),
            )
            return None

    def _comment_issue_pr_revert(
        self,
        commit_sha: str,
        sources: List[SignalMetadata],
        ctx: RunContext,
    ) -> bool:
        logging.debug(
            "[v2][action] (%s) revert for sha %s: finding the PR notifying",
            ctx.revert_action,
            commit_sha[:8],
        )

        # find the PR from commit_sha on main
        pr_result = self._find_pr_by_sha(commit_sha, ctx)
        if not pr_result:
            logging.error(
                "[v2][action] (%s) revert for sha %s: no PR found!",
                ctx.revert_action,
                commit_sha[:8],
            )
            return False

        action_type, pr = pr_result
        should_do_revert_on_pr = (
            ctx.revert_action == RevertAction.RUN_REVERT
            and action_type == CommitPRSourceAction.MERGE
        )

        # If the PR is still open, do not request a bot revert.
        # This covers cases where the commit belongs to an open PR
        # (not yet merged) or the PR has already been reverted and is open.
        # In such cases, fall back to posting a notification comment only.
        if should_do_revert_on_pr:
            pr_state = getattr(pr, "state", None)
            if pr_state == "open":
                logging.info(
                    "[v2][action] (%s, %s) revert for sha %s: PR #%s is open, will just notify",
                    ctx.revert_action,
                    action_type,
                    commit_sha[:8],
                    pr.number,
                )
                should_do_revert_on_pr = False

        if should_do_revert_on_pr:
            # check if label 'autorevert: disable' is on the `pr`
            labels = []
            for attempt in RetryWithBackoff():
                with attempt:
                    labels = [label.name for label in pr.labels]
            if "autorevert: disable" in labels:
                logging.info(
                    "[v2][action] (%s, %s) revert for sha %s: author disabled autorevert for PR #%d",
                    ctx.revert_action,
                    action_type,
                    commit_sha[:8],
                    pr.number,
                )
                # if PR is a merge, and we're running on revert mode, but the author disabled autorevert
                # for the PR, we notify anyways
                should_do_revert_on_pr = False
            else:
                logging.info(
                    "[v2][action] (%s, %s) revert for sha %s: requesting pytorchbot revert in PR #%d",
                    ctx.revert_action,
                    action_type,
                    commit_sha[:8],
                    pr.number,
                )
        else:
            logging.info(
                "[v2][action] (%s, %s) revert for sha %s: no revert requested for PR #%s, will just notify",
                ctx.revert_action,
                action_type,
                commit_sha[:8],
                pr.number,
            )

        # Group workflow sources
        workflow_groups = defaultdict(list)
        for source in sources:
            workflow_groups[source.workflow_name].append(source)

        # Build a nice message to show which workflows are broken
        # used both to revert and notify
        breaking_notification_msg = (
            "This PR is attributed to have caused regression in:\n"
        )
        for workflow_name, wf_sources in workflow_groups.items():
            all_signals_urls = []
            for wf_source in wf_sources:
                curr_url = ""

                if wf_source.job_id and wf_source.wf_run_id:
                    job_url = build_job_pytorch_url(
                        repo_full_name=ctx.repo_full_name,
                        wf_run_id=str(wf_source.wf_run_id),
                        job_id=str(wf_source.job_id),
                    )
                    curr_url += f"[{wf_source.key}]({job_url})"
                else:
                    curr_url += wf_source.key

                if wf_source.job_base_name:
                    hud_url = build_pytorch_hud_url(
                        repo_full_name=ctx.repo_full_name,
                        top_sha=commit_sha,
                        num_commits=50,
                        job_base_name=wf_source.job_base_name,
                    )
                    curr_url += f" ([hud]({hud_url}))"

                all_signals_urls.append(curr_url)

            all_signals = ", ".join(all_signals_urls)
            breaking_notification_msg += f"- {workflow_name}: {all_signals}\n"

        # Add AI advisor info if any signal was advisor-accelerated
        advisor_summaries = [s.advisor_summary for s in sources if s.advisor_summary]
        if advisor_summaries:
            breaking_notification_msg += (
                "\n**Note:** This revert was accelerated by the AI advisor: "
                + "; ".join(advisor_summaries)
                + "\n"
            )

        try:
            if should_do_revert_on_pr:
                for attempt in RetryWithBackoff():
                    with attempt:
                        pr.create_issue_comment(
                            "@pytorchbot revert -m \"Reverted automatically by pytorch's autorevert, "
                            + 'to avoid this behaviour add the tag autorevert: disable" -c autorevert\n'
                            + "\n"
                            + breaking_notification_msg
                            + "\nPlease investigate and fix the issues."
                            + "\n"
                            + "@claude Can you please read this revert comment, follow the links and "
                            + "read the errors, to then give a brief diagnostics on the cause of the "
                            + "error? If you judge the error to be legitimate reason for a revert, "
                            + "please provide brief guidance on how the author could fix it."
                        )
                        logging.warning(
                            "[v2][action] revert for sha %s: requested pytorchbot revert in PR #%d",
                            commit_sha[:8],
                            pr.number,
                        )
                        return True

            for attempt in RetryWithBackoff():
                with attempt:
                    # Gets the main issue and notify
                    issue = (
                        GHClientFactory()
                        .client.get_repo(ctx.repo_full_name)
                        .get_issue(number=ctx.notify_issue_number)
                    )
                    issue.create_comment(
                        f"Autorevert detected a possible offender: {commit_sha[:8]} from PR #{pr.number}.\n\n"
                        + (
                            "The commit is a revert"
                            if action_type == CommitPRSourceAction.REVERT
                            else "The commit is a PR merge"
                        )
                        + "\n\n"
                        + breaking_notification_msg
                    )
                    logging.info(
                        "[v2][action] revert for sha %s: added notification on the issue #%d",
                        commit_sha[:8],
                        ctx.notify_issue_number,
                    )

            # we succeeded if we requested a notification, if the action is a revert but it could not be performed
            # due to either the author disabling autorevert or the PR not being a merge we return False
            return ctx.revert_action == RevertAction.RUN_NOTIFY

        except Exception:
            logging.exception(
                "[v2][action] revert for sha %s: error occurred",
                commit_sha[:8],
            )
            return False
