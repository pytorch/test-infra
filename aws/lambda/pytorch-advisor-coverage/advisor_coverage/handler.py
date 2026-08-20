"""Lambda entrypoint + local CLI for the advisor-coverage dispatcher.

- `lambda_handler(event, context)` — invoked by EventBridge (ongoing cron) or a
  manual event. Event overrides use lowercase config field-name keys, e.g.
  `{"mode": "backfill", "as_of_start": "2026-01-01", "as_of_end": "2026-06-30"}`.
- `main_cli()` — local / `python -m advisor_coverage` entrypoint.

Ongoing enumerates unclassified reds in `[now - HOURS, now)`. Lambda backfill
runs a wall-clock-bounded, dispatch-capped pass and returns a `next_as_of`
cursor for the caller to resume; local backfill runs the whole range to
completion in one process.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from dotenv import load_dotenv

from .backfill import run_backfill
from .bootstrap import configure_logging, setup_clients
from .config import (
    BACKFILL_WALL_CLOCK_BUDGET_SECONDS,
    CoverageConfig,
    PERSISTENCE_MARGIN_HOURS,
)
from .dispatcher import CoverageDispatcher


log = logging.getLogger(__name__)


def _run_ongoing(config: CoverageConfig) -> Dict[str, Any]:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    emit_start = now - timedelta(hours=config.hours)
    # Widen the enum window back by the persistence margin so edge reds get their
    # preceding-commit context; the newest-commit edge (now) has no lookahead —
    # inherent and matches /flaky_trunk.
    enum_start = emit_start - timedelta(hours=PERSISTENCE_MARGIN_HOURS)
    dispatcher = CoverageDispatcher(config)
    dispatcher.begin_run(config.effective_max_dispatches())
    deadline = time.monotonic() + BACKFILL_WALL_CLOCK_BUDGET_SECONDS
    stats = dispatcher.dispatch_for_window(
        enum_start, now, emit_start=emit_start, emit_stop=now, deadline=deadline
    )
    result = {"mode": "ongoing", "dry_run": config.dry_run, **stats.as_dict()}
    log.info("[coverage] ongoing complete: %s", result)
    return result


def _run_backfill_lambda(config: CoverageConfig) -> Dict[str, Any]:
    """Wall-clock-bounded, dispatch-capped pass; returns a resume cursor."""
    dispatcher = CoverageDispatcher(config)
    deadline = time.monotonic() + BACKFILL_WALL_CLOCK_BUDGET_SECONDS
    return run_backfill(
        config,
        dispatcher,
        deadline=deadline,
        limit=config.effective_max_dispatches(),
    )


def _run_backfill_local(config: CoverageConfig) -> Dict[str, Any]:
    """Complete the whole range in one process — unlimited budget, no deadline.

    Only the gap throttle applies (the per-run dispatch cap is NOT applied to a
    local full backfill).
    """
    dispatcher = CoverageDispatcher(config)
    return run_backfill(config, dispatcher, deadline=None, limit=None)


def lambda_handler(event: Optional[Dict[str, Any]], context: object) -> Dict[str, Any]:
    """AWS Lambda entrypoint (EventBridge cron or manual backfill event)."""
    config = CoverageConfig.from_env_and_event(event or {})
    configure_logging(config.log_level)
    setup_clients(config)
    if config.mode == "backfill":
        return _run_backfill_lambda(config)
    return _run_ongoing(config)


def main_cli(force_mode: Optional[str] = None) -> Dict[str, Any]:
    """Local entrypoint used by `python -m advisor_coverage[.backfill]`."""
    load_dotenv()
    event: Dict[str, Any] = {"mode": force_mode} if force_mode else {}
    config = CoverageConfig.from_env_and_event(event)
    configure_logging(config.log_level)
    setup_clients(config)
    if config.mode == "backfill":
        result = _run_backfill_local(config)
    else:
        result = _run_ongoing(config)
    print(json.dumps(result, indent=2, default=str))
    return result
