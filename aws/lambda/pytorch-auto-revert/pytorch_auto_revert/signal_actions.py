from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, Iterable, List, Optional, Tuple, Union

import github

from .clickhouse_client_helper import CHCliFactory
from .github_client_helper import GHClientFactory
from .signal import AutorevertPattern, Ineligible, RestartCommits, Signal
from .signal_extraction_types import RunContext
from .utils import RestartAction, RetryWithBackoff, RevertAction
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


@dataclass(frozen=True)
class ActionGroup:
    """A coalesced action candidate built from one or more signals.

    - type: 'revert' | 'restart'
    - commit_sha: target commit
    - workflow_target: workflow to restart (restart only); None/'' for revert
    - sources: contributing signals (workflow_name, key)
    """

    type: str  # 'revert' | 'restart'
    commit_sha: str
    workflow_target: str | None  # restart-only; None/'' for revert
    sources: List[SignalMetadata]


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
            "      any(failed = 0 AND ts > (now() - toIntervalSecond({pacing_sec:UInt32}))) "
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
            meta = SignalMetadata(workflow_name=sig.workflow_name, key=sig.key)
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
            groups.append(
                ActionGroup(
                    type="restart",
                    commit_sha=sha,
                    workflow_target=wf,
                    sources=sources,
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

        notes = ""
        ok = True
        if not dry_run:
            try:
                self._restart.restart_workflow(workflow_target, commit_sha)
            except Exception as exc:
                ok = False
                notes = str(exc) or repr(exc)
                logging.exception(
                    "[v2][action] restart for sha %s: exception while dispatching",
                    commit_sha[:8],
                )
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
        self, commit_sha: str, sources: List[SignalMetadata], ctx: RunContext
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
        breaking_notification_msg = "This PR is breaking the following workflows:\n"
        for workflow_name, sources in workflow_groups.items():
            all_signals = ", ".join([source.key for source in sources])
            breaking_notification_msg += f"- {workflow_name}: {all_signals}\n"

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
