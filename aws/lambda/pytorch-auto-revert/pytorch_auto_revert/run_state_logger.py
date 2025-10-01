from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Tuple, Union

from .clickhouse_client_helper import CHCliFactory
from .signal import AutorevertPattern, Ineligible, RestartCommits, Signal
from .signal_extraction_types import RunContext
from .utils import RetryWithBackoff


SignalProcOutcome = Union[AutorevertPattern, RestartCommits, Ineligible]


class RunStateLogger:
    """Serialize the run’s HUD-like state and insert a single row into misc.autorevert_state.

    The state JSON captures:
    - commits (newest→older) and minimal started_at timestamps per commit
    - per-signal columns with outcome, human notes, ineligible details, and per-commit events
    - run metadata (repo, workflows, lookback_hours, ts, dry_run)
    """

    def _build_state_json(
        self,
        *,
        repo: str,
        ctx: RunContext,
        pairs: Iterable[Tuple[Signal, SignalProcOutcome]],
    ) -> Dict[str, Any]:
        """Build a dictionary describing the run’s HUD-like grid and outcomes."""
        pairs_list = list(pairs)
        signals: List[Signal] = [s for s, _ in pairs_list]

        # Collect commit order (newest → older) across signals
        commits: List[str] = []
        commit_times: Dict[str, str] = {}
        seen = set()
        for s in signals:
            for c in s.commits:
                if c.head_sha not in seen:
                    seen.add(c.head_sha)
                    commits.append(c.head_sha)
                    commit_times[c.head_sha] = c.timestamp.isoformat()

        # sorting commits by their timestamp
        commits.sort(key=lambda sha: commit_times[sha], reverse=True)

        # Build columns with outcomes, notes, and per-commit events
        cols = []
        outcome_map: Dict[str, Dict[str, Any]] = {}
        for sig, outcome in pairs_list:
            if isinstance(outcome, AutorevertPattern):
                oc = "revert"
                ineligible = None
                serialized = {
                    "type": "AutorevertPattern",
                    "data": {
                        "workflow_name": outcome.workflow_name,
                        "suspected_commit": outcome.suspected_commit,
                        "older_successful_commit": outcome.older_successful_commit,
                        "newer_failing_commits": list(outcome.newer_failing_commits),
                    },
                }
            elif isinstance(outcome, RestartCommits):
                oc = "restart"
                ineligible = None
                serialized = {
                    "type": "RestartCommits",
                    "data": {
                        "commit_shas": sorted(outcome.commit_shas),
                    },
                }
            else:
                oc = "ineligible"
                ineligible = {
                    "reason": outcome.reason.value,
                    "message": outcome.message,
                }
                serialized = {
                    "type": "Ineligible",
                    "data": {
                        "reason": outcome.reason.value,
                        "message": outcome.message,
                    },
                }

            # Per-commit events for this signal
            cells: Dict[str, List[Dict]] = {}
            for c in sig.commits:
                evs = []
                for e in c.events:
                    ev = {
                        "status": e.status.value,
                        "started_at": e.started_at.isoformat(),
                        "name": e.name,
                    }
                    if e.ended_at:
                        ev["ended_at"] = e.ended_at.isoformat()
                    if e.job_id is not None:
                        ev["job_id"] = e.job_id
                    if e.run_attempt is not None:
                        ev["run_attempt"] = e.run_attempt
                    evs.append(ev)
                if evs:
                    cells[c.head_sha] = evs

            col = {
                "workflow": sig.workflow_name,
                "key": sig.key,
                "outcome": oc,
                "cells": cells,
            }
            if sig.job_base_name:
                col["job_base_name"] = sig.job_base_name
            if ineligible is not None:
                col["ineligible"] = ineligible
            cols.append(col)

            sig_key = f"{sig.workflow_name}:{sig.key}"
            outcome_map[sig_key] = serialized

        doc: Dict[str, Any] = {
            "version": 2,
            "commits": commits,
            "commit_times": commit_times,
            "columns": cols,
            "outcomes": outcome_map,
            "meta": {
                "repo": repo,
                "workflows": ctx.workflows,
                "lookback_hours": ctx.lookback_hours,
                "ts": ctx.ts.isoformat(),
                "restart_action": str(ctx.restart_action),
                "revert_action": str(ctx.revert_action),
            },
        }
        return doc

    def insert_state(
        self,
        *,
        ctx: RunContext,
        pairs: Iterable[Tuple[Signal, SignalProcOutcome]],
        params: str = "",
    ) -> str:
        """Insert one state row into misc.autorevert_state for this run context.

        Returns the serialized JSON state that was stored, so callers can reuse it
        for local rendering/debugging without rebuilding the structure.
        """
        doc = self._build_state_json(repo=ctx.repo_full_name, ctx=ctx, pairs=pairs)
        state_json = json.dumps(doc, separators=(",", ":"))
        cols = [
            "ts",
            "repo",
            "state",
            "dry_run",
            "workflows",
            "lookback_hours",
            "params",
        ]
        data = [
            [
                ctx.ts,
                ctx.repo_full_name,
                state_json,
                1
                if not (
                    ctx.restart_action.side_effects or ctx.revert_action.side_effects
                )
                else 0,
                ctx.workflows,
                int(ctx.lookback_hours),
                params or "",
            ]
        ]
        for attempt in RetryWithBackoff():
            with attempt:
                CHCliFactory().client.insert(
                    table="autorevert_state",
                    data=data,
                    column_names=cols,
                    database="misc",
                )
        return state_json
