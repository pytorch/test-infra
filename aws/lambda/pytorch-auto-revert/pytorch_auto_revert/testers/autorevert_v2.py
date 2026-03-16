import logging
from datetime import datetime, timezone
from typing import Iterable, List, Optional, Tuple

from ..run_state_logger import RunStateLogger
from ..signal import Signal
from ..signal_actions import SignalActionProcessor, SignalProcOutcome
from ..signal_extraction import SignalExtractor
from ..signal_extraction_types import RunContext
from ..utils import RestartAction, RevertAction


def autorevert_v2(
    workflows: Iterable[str],
    *,
    notify_issue_number: int,
    hours: int = 24,
    repo_full_name: str = "pytorch/pytorch",
    restart_action: RestartAction = RestartAction.RUN,
    revert_action: RevertAction = RevertAction.LOG,
    bisection_limit: Optional[int] = None,
    as_of: Optional[datetime] = None,
    revert_decisions_sqs_queue_url: str = "",
) -> Tuple[List[Signal], List[Tuple[Signal, SignalProcOutcome]], str]:
    """Run the Signals-based autorevert flow end-to-end.

    - Extracts signals for the specified workflows and window
    - Computes per-signal outcomes, groups actions, enforces dedup/caps, and executes
    - Persists a single HUD-like state row for auditability

    Returns:
        (signals, pairs, state_json) for diagnostics and potential external rendering
    """
    workflows = list(workflows)
    # Use timezone-aware UTC to match ClickHouse DateTime semantics
    ts = datetime.now(timezone.utc)

    logging.info(
        "[v2] Start: workflows=%s hours=%s repo=%s restart_action=%s"
        " revert_action=%s notify_issue_number=%s bisection=%s as_of=%s",
        ",".join(workflows),
        hours,
        repo_full_name,
        restart_action,
        revert_action,
        notify_issue_number,
        ("unlimited" if bisection_limit is None else f"limit={bisection_limit}"),
        (as_of.isoformat() if as_of else "now"),
    )
    logging.info("[v2] Run timestamp (CH log ts) = %s", ts.isoformat())

    extractor = SignalExtractor(
        workflows=workflows,
        lookback_hours=hours,
        repo_full_name=repo_full_name,
        as_of=as_of,
    )
    signals = extractor.extract()
    logging.info("[v2] Extracted %d signals", len(signals))

    # Process signals to outcomes
    pairs: List[Tuple[Signal, SignalProcOutcome]] = []
    for s in signals:
        outcome = s.process_valid_autorevert_pattern(bisection_limit=bisection_limit)
        pairs.append((s, outcome))
        logging.info(
            "[v2][signal] wf=%s key=%s outcome=%s", s.workflow_name, s.key, str(outcome)
        )

    # Build run context
    run_ctx = RunContext(
        lookback_hours=hours,
        notify_issue_number=notify_issue_number,
        repo_full_name=repo_full_name,
        restart_action=restart_action,
        revert_action=revert_action,
        ts=ts,
        revert_decisions_sqs_queue_url=revert_decisions_sqs_queue_url,
        workflows=workflows,
    )

    # Group and execute actions
    proc = SignalActionProcessor()
    groups = proc.group_actions(pairs)
    logging.info("[v2] Candidate action groups: %d", len(groups))

    executed_count = sum(1 for g in groups if proc.execute(g, run_ctx))
    logging.info("[v2] Executed action groups: %d", executed_count)

    # Persist full run state via separate logger
    try:
        state_json = RunStateLogger().insert_state(ctx=run_ctx, pairs=pairs)
        logging.info("[v2] State logged")
    except Exception:
        logging.exception("[v2] State logging failed")  # capture full stack
        # Keep returning a JSON payload for downstream consumers
        state_json = "{}"

    return signals, pairs, state_json
