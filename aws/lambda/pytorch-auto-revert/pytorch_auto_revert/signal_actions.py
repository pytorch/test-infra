from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, Iterable, List, Optional, Tuple, Union

import github

from .clickhouse_client_helper import CHCliFactory, ensure_utc_datetime
from .github_client_helper import GHClientFactory
from .signal import AutorevertPattern, Ineligible, RestartCommits, Signal
from .signal_extraction_types import RunContext
from .utils import RestartAction, RevertAction
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
        res = CHCliFactory().client.query(q, {"repo": repo, "sha": commit_sha})
        return len(res.result_rows) > 0

    def recent_restarts(
        self, *, repo: str, workflow: str, commit_sha: str, limit: int = 2
    ):
        """Return most recent non-dry-run restart timestamps for (workflow, commit)."""
        q = (
            "SELECT ts FROM misc.autorevert_events_v2 "
            "WHERE repo = {repo:String} AND action = 'restart' AND dry_run = 0 "
            "AND commit_sha = {sha:String} AND has(workflows, {wf:String}) "
            "ORDER BY ts DESC LIMIT {lim:UInt16}"
        )
        res = CHCliFactory().client.query(
            q, {"repo": repo, "wf": workflow, "sha": commit_sha, "lim": limit}
        )
        return [ensure_utc_datetime(ts) for (ts,) in res.result_rows]

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
        CHCliFactory().client.insert(
            table="autorevert_events_v2", data=data, column_names=cols, database="misc"
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
            self._comment_pr_notify_revert(commit_sha, sources, ctx)

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
        """Dispatch a workflow restart if under cap and outside pacing window; always logs the event."""
        if ctx.restart_action == RestartAction.SKIP:
            logging.info(
                "[v2][action] restart for sha %s: skipping (ignored)", commit_sha[:8]
            )
            return False

        dry_run = not ctx.restart_action.side_effects

        recent = self._logger.recent_restarts(
            repo=ctx.repo_full_name, workflow=workflow_target, commit_sha=commit_sha
        )
        if len(recent) >= 2:
            logging.info(
                "[v2][action] restart for sha %s: skipping cap (recent=%d)",
                commit_sha[:8],
                len(recent),
            )
            return False
        if recent and (ctx.ts - recent[0]) < timedelta(minutes=15):
            delta = (ctx.ts - recent[0]).total_seconds()
            logging.info(
                "[v2][action] restart for sha %s: skipping pacing (delta_sec=%d)",
                commit_sha[:8],
                int(delta),
            )
            return False

        notes = ""
        ok = True
        if not dry_run:
            ok = self._restart.restart_workflow(workflow_target, commit_sha)
            if not ok:
                notes = "dispatch_failed"
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
        elif not ok:
            logging.info(
                "[v2][action] restart for sha %s: dispatch_failed: %s",
                commit_sha[:8],
                notes,
            )
        else:
            logging.info(
                "[v2][action] restart for sha %s: logged (dry_run)", commit_sha[:8]
            )
        return True

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
            # Get GitHub client
            gh_client = GHClientFactory().client
            repo = gh_client.get_repo(ctx.repo_full_name)

            # Get the commit to check its message
            commit = repo.get_commit(commit_sha)
            commit_message = commit.commit.message

            # First check: parse commit message for PR references
            # This is the most reliable way to determine the pytorchbot action
            # Use findall to get all matches and pick the last one (pytorchbot appends at the end)

            # Look for "Reverted #XXXXX" - indicates a revert action
            revert_matches = re.findall(
                r"Reverted https://github.com/pytorch/pytorch/pull/(\d+)",
                commit_message,
            )
            if revert_matches:
                pr_number = int(revert_matches[-1])  # Use the last match
                try:
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

            # Look for "Pull Request resolved: #XXXXX" - indicates a merge action
            pr_resolved_matches = re.findall(
                r"Pull Request resolved: https://github.com/pytorch/pytorch/pull/(\d+)",
                commit_message,
            )
            if pr_resolved_matches:
                pr_number = int(pr_resolved_matches[-1])  # Use the last match
                try:
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
            search_query = f"{commit_sha} repo:{ctx.repo_full_name} is:pr is:closed"
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

    def _comment_pr_notify_revert(
        self, commit_sha: str, sources: List[SignalMetadata], ctx: RunContext
    ) -> bool:
        """Comment on the pull request to notify the author about that their PR is breaking signals."""

        logging.debug(
            "[v2][action] revert for sha %s: finding the PR andnotifying author",
            commit_sha[:8],
        )

        # find the PR from commit_sha on main
        pr_result = self._find_pr_by_sha(commit_sha, ctx)
        if not pr_result:
            logging.error(
                "[v2][action] revert for sha %s: no PR found!", commit_sha[:8]
            )
            return False

        action_type, pr = pr_result
        if action_type == CommitPRSourceAction.REVERT:
            logging.warning(
                "[v2][action] revert for sha %s: PR #%d is already a revert, skipping comment",
                commit_sha[:8],
                pr.number,
            )
            return False

        # Comment on the PR to notify the author about the revert
        comment_body = (
            "This PR is breaking the following workflows:\n"
            + "- {}".format("\n- ".join(source.workflow_name for source in sources))
            + "\n\nPlease investigate and fix the issues."
        )

        pr.create_issue_comment(comment_body)
        logging.warning(
            "[v2][action] revert for sha %s: notified author in PR #%d",
            commit_sha[:8],
            pr.number,
        )

        if ctx.revert_action == RevertAction.RUN_REVERT:
            # TODO Add autorevert cause for pytorchbot OR decide if we need to use
            # other causes like weird

            # TODO check if the tag `autorevert:disable` is present and don't do the revert
            # comment, instead limiting to poke the author
            comment_body = (
                "XXXX revert -m \"Reverted automatically by pytorch's autorevert, "
                + 'to avoid this behaviour add the tag autorevert:disable" -c autorevert'
            )
            pr.create_issue_comment(comment_body)
            logging.warning(
                "[v2][action] revert for sha %s: requested pytorchbot revert in PR #%d",
                commit_sha[:8],
                pr.number,
            )

        return True
