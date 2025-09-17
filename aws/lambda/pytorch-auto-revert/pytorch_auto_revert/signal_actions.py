from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Tuple, Union

from .clickhouse_client_helper import CHCliFactory, ensure_utc_datetime
from .signal import AutorevertPattern, Ineligible, RestartCommits, Signal
from .signal_extraction_types import RunContext
from .utils import RestartRevertAction
from .workflow_checker import WorkflowRestartChecker


# Alias for outcomes produced by signal processing
SignalProcOutcome = Union[AutorevertPattern, RestartCommits, Ineligible]


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

    def prior_revert_exists(
        self, *, repo: str, commit_sha: str, accept_dry_run: bool
    ) -> bool:
        """Return True if a non-dry-run revert was already logged for commit_sha."""
        accept_dry_run_term = (
            "AND dry_run = {accept_dry_run:Boolean}" if not accept_dry_run else ""
        )
        q = (
            "SELECT 1 FROM misc.autorevert_events_v2 "
            "WHERE repo = {repo:String} AND action = 'revert' "
            f"AND commit_sha = {{sha:String}} {accept_dry_run_term} LIMIT 1"
        )
        res = CHCliFactory().client.query(
            q,
            {
                "repo": repo,
                "sha": commit_sha,
            },
        )
        return len(res.result_rows) > 0

    def recent_restarts(
        self,
        *,
        repo: str,
        workflow: str,
        commit_sha: str,
        limit: int = 2,
        accept_dry_run: bool,
    ):
        """Return most recent non-dry-run restart timestamps for (workflow, commit)."""
        accept_dry_run_term = (
            "AND dry_run = {accept_dry_run:Boolean}" if not accept_dry_run else ""
        )
        q = (
            "SELECT ts FROM misc.autorevert_events_v2 "
            f"WHERE repo = {repo:String} AND action = 'restart' {accept_dry_run_term} "
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
        if ctx.revert_action == RestartRevertAction.IGNORE:
            logging.debug(
                "[v2][action] revert for sha %s: skipping (ignored)", commit_sha[:8]
            )
            return False

        dry_run = ctx.revert_action == RestartRevertAction.DRY_RUN

        if self._logger.prior_revert_exists(
            repo=ctx.repo_full_name, commit_sha=commit_sha, accept_dry_run=dry_run
        ):
            logging.info(
                "[v2][action] revert for sha %s: skipping existing", commit_sha[:8]
            )
            return False

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
        if ctx.restart_action == RestartRevertAction.IGNORE:
            logging.info(
                "[v2][action] restart for sha %s: skipping (ignored)", commit_sha[:8]
            )
            return False

        dry_run = ctx.revert_action == RestartRevertAction.DRY_RUN

        recent = self._logger.recent_restarts(
            repo=ctx.repo_full_name,
            workflow=workflow_target,
            commit_sha=commit_sha,
            accept_dry_run=dry_run,
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
        if not dry_run and notes == "":
            logging.info("[v2][action] restart for sha %s: dispatched", commit_sha[:8])
        elif notes:
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
