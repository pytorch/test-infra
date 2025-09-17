from __future__ import annotations

import json
from typing import Dict, Iterable, List, Tuple, Union

from .clickhouse_client_helper import CHCliFactory
from .signal import AutorevertPattern, Ineligible, RestartCommits, Signal
from .signal_extraction_types import RunContext


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
    ) -> str:
        """Build a compact JSON string describing the run’s HUD-like grid and outcomes."""
        pairs_list = list(pairs)
        signals: List[Signal] = [s for s, _ in pairs_list]

        # Collect commit order (newest → older) across signals
        commits: List[str] = []
        seen = set()
        for s in signals:
            for c in s.commits:
                if c.head_sha not in seen:
                    seen.add(c.head_sha)
                    commits.append(c.head_sha)

        # Compute minimal started_at per commit (for timestamp context)
        commit_times: Dict[str, str] = {}
        for sha in commits:
            tmin_iso: str | None = None
            for s in signals:
                # find commit in this signal
                sc = next((cc for cc in s.commits if cc.head_sha == sha), None)
                if not sc or not sc.events:
                    continue
                # events are sorted oldest first
                t = sc.events[0].started_at
                ts_iso = t.isoformat()
                if tmin_iso is None or ts_iso < tmin_iso:
                    tmin_iso = ts_iso
            if tmin_iso is not None:
                commit_times[sha] = tmin_iso

        # Build columns with outcomes, notes, and per-commit events
        cols = []
        for sig, outcome in pairs_list:
            if isinstance(outcome, AutorevertPattern):
                oc = "revert"
                note = (
                    f"Pattern: newer fail {len(outcome.newer_failing_commits)}; "
                    f"suspect {outcome.suspected_commit[:7]} vs baseline {outcome.older_successful_commit[:7]}"
                )
                ineligible = None
            elif isinstance(outcome, RestartCommits):
                oc = "restart"
                if outcome.commit_shas:
                    short = ", ".join(sorted(s[:7] for s in outcome.commit_shas))
                    note = f"Suggest restart: {short}"
                else:
                    note = "Suggest restart: <none>"
                ineligible = None
            else:
                oc = "ineligible"
                note = f"Ineligible: {outcome.reason.value}"
                if outcome.message:
                    note += f" — {outcome.message}"
                ineligible = {
                    "reason": outcome.reason.value,
                    "message": outcome.message,
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
                    evs.append(ev)
                if evs:
                    cells[c.head_sha] = evs

            col = {
                "workflow": sig.workflow_name,
                "key": sig.key,
                "outcome": oc,
                "note": note,
                "cells": cells,
            }
            if ineligible is not None:
                col["ineligible"] = ineligible
            cols.append(col)

        doc = {
            "commits": commits,
            "commit_times": commit_times,
            "columns": cols,
            "meta": {
                "repo": repo,
                "workflows": ctx.workflows,
                "lookback_hours": ctx.lookback_hours,
                "ts": ctx.ts.isoformat(),
                "dry_run": ctx.dry_run,
            },
        }
        return json.dumps(doc, separators=(",", ":"))

    def insert_state(
        self,
        *,
        ctx: RunContext,
        pairs: Iterable[Tuple[Signal, SignalProcOutcome]],
        params: str = "",
    ) -> None:
        """Insert one state row into misc.autorevert_state for this run context."""
        state_json = self._build_state_json(
            repo=ctx.repo_full_name, ctx=ctx, pairs=list(pairs)
        )
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
                1 if ctx.dry_run else 0,
                ctx.workflows,
                int(ctx.lookback_hours),
                params or "",
            ]
        ]
        CHCliFactory().client.insert(
            table="autorevert_state", data=data, column_names=cols, database="misc"
        )
