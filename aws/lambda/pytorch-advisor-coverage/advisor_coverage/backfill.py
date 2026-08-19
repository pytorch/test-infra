"""Backfill driver: enumerate unclassified reds over a historical time range.

Straight time-window enumeration (no as_of replay): tile [as_of_start, as_of_end)
into `as_of_step_hours` chunks and dispatch each chunk's unclassified reds. Each
chunk is enumerated with a persistence margin on both sides (so the SQL lag/lead
check sees neighbouring trunk commits) but dispatches only reds whose commit_time
is inside the core chunk. One Lambda invocation is bounded by a wall-clock budget
(and the dispatch cap); when it stops early it RETURNS a resume cursor. Re-invoking
with `as_of_start` = that cursor is what makes a long backfill complete without any
single run hitting the timeout. A local `python -m` run passes limit=None /
deadline=None and completes the whole range in one process.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any, Dict, List, Optional

from .config import CoverageConfig, PERSISTENCE_MARGIN_HOURS
from .dispatcher import CoverageDispatcher
from .enumeration import _naive_utc


log = logging.getLogger(__name__)

# Naive-UTC cursor format — parseable by the vendored parse_datetime (no %z).
_CURSOR_FMT = "%Y-%m-%d %H:%M:%S"


def run_backfill(
    config: CoverageConfig,
    dispatcher: CoverageDispatcher,
    *,
    deadline: Optional[float] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Dispatch unclassified reds across [as_of_start, as_of_end) in chunks.

    Stops when the range is exhausted, the dispatch budget (`limit`, None =
    unlimited) is spent, or `deadline` (a `time.monotonic()` value) is reached.
    A chunk that caps mid-way (budget or per-window deadline) does NOT advance
    the cursor — the returned `next_as_of` resumes at that chunk's start so no
    red is lost. Returns metrics plus `next_as_of` (None when complete), emitted
    as a naive-UTC string the resume caller can parse.
    """
    if config.as_of_start is None or config.as_of_end is None:
        raise ValueError("backfill requires as_of_start and as_of_end")
    if config.as_of_start > config.as_of_end:
        raise ValueError("as_of_start must be <= as_of_end")
    if config.as_of_step_hours <= 0:
        raise ValueError("as_of_step_hours must be positive")

    start = _naive_utc(config.as_of_start)
    end = _naive_utc(config.as_of_end)
    step = timedelta(hours=config.as_of_step_hours)
    margin = timedelta(hours=PERSISTENCE_MARGIN_HOURS)
    dispatcher.begin_run(limit)

    cursor = start
    chunks_run = 0
    per_chunk: List[Dict[str, Any]] = []
    next_as_of: Optional[str] = None
    stop_reason = "complete"

    while cursor < end:
        if dispatcher.remaining is not None and dispatcher.remaining <= 0:
            next_as_of, stop_reason = cursor.strftime(_CURSOR_FMT), "budget"
            break
        if deadline is not None and time.monotonic() >= deadline:
            next_as_of, stop_reason = cursor.strftime(_CURSOR_FMT), "deadline"
            break
        chunk_stop = min(cursor + step, end)
        try:
            stats = dispatcher.dispatch_for_window(
                cursor - margin,
                chunk_stop + margin,
                emit_start=cursor,
                emit_stop=chunk_stop,
                deadline=deadline,
            )
            per_chunk.append(stats.as_dict())
        except Exception:
            log.exception(
                "[coverage] backfill chunk failed at %s", cursor.strftime(_CURSOR_FMT)
            )
            next_as_of, stop_reason = cursor.strftime(_CURSOR_FMT), "error"
            break
        chunks_run += 1
        if stats.capped:
            # Budget / per-window deadline hit mid-chunk — resume INSIDE this
            # chunk (do NOT advance to chunk_stop) so the undispatched reds in it
            # are re-enumerated next invocation.
            next_as_of, stop_reason = cursor.strftime(_CURSOR_FMT), "capped"
            break
        cursor = chunk_stop

    result = {
        "mode": "backfill",
        "dry_run": config.dry_run,
        "chunks_run": chunks_run,
        "dispatched": dispatcher.success_total,
        "attempts": dispatcher.attempts_total,
        "stop_reason": stop_reason,
        "next_as_of": next_as_of,
        "as_of_start": start.strftime(_CURSOR_FMT),
        "as_of_end": end.strftime(_CURSOR_FMT),
        "as_of_step_hours": config.as_of_step_hours,
        "per_chunk": per_chunk,
    }
    log.info(
        "[coverage] backfill pass: chunks=%d dispatched=%d stop=%s next_as_of=%s",
        chunks_run,
        dispatcher.success_total,
        stop_reason,
        next_as_of,
    )
    return result


def main() -> None:
    # Local / manual entrypoint: `python -m advisor_coverage.backfill`.
    from .handler import main_cli

    main_cli(force_mode="backfill")


if __name__ == "__main__":
    main()
