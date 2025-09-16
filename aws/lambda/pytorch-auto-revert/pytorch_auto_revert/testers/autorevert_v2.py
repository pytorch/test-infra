import logging
from datetime import datetime
from typing import Iterable, List, Tuple

from ..run_state_logger import RunStateLogger
from ..signal import Signal
from ..signal_actions import SignalActionProcessor, SignalProcOutcome
from ..signal_extraction import SignalExtractor
from ..signal_extraction_types import RunContext


def autorevert_v2(
    workflows: Iterable[str],
    *,
    hours: int = 24,
    repo_full_name: str = "pytorch/pytorch",
    dry_run: bool = False,
    do_restart: bool = True,
    do_revert: bool = True,
) -> Tuple[List[Signal], List[Tuple[Signal, SignalProcOutcome]]]:
    """Run the Signals-based autorevert flow end-to-end.

    - Extracts signals for the specified workflows and window
    - Computes per-signal outcomes, groups actions, enforces dedup/caps, and executes
    - Persists a single HUD-like state row for auditability

    Returns:
        (signals, pairs) for diagnostics and potential external rendering
    """
    workflows = list(workflows)
    ts = datetime.now()

    logging.info(
        "[v2] Start: workflows=%s hours=%s repo=%s dry_run=%s",
        ",".join(workflows),
        hours,
        repo_full_name,
        dry_run,
    )
    logging.info("[v2] Run timestamp (CH log ts) = %s", ts.isoformat())

    extractor = SignalExtractor(
        workflows=workflows, lookback_hours=hours, repo_full_name=repo_full_name
    )
    signals = extractor.extract()
    logging.info("[v2] Extracted %d signals", len(signals))

    # Process signals to outcomes
    pairs: List[Tuple[Signal, SignalProcOutcome]] = []
    for s in signals:
        outcome = s.process_valid_autorevert_pattern()
        pairs.append((s, outcome))
        logging.info(
            "[v2][signal] wf=%s key=%s outcome=%s", s.workflow_name, s.key, str(outcome)
        )

    # Build run context
    run_ctx = RunContext(
        ts=ts,
        repo_full_name=repo_full_name,
        workflows=workflows,
        lookback_hours=hours,
        dry_run=dry_run,
    )

    # Group and execute actions
    proc = SignalActionProcessor()
    groups = proc.group_actions(pairs)
    logging.info("[v2] Candidate action groups: %d", len(groups))

    # Support toggling specific kinds of actions via flags
    if not do_revert:
        groups = [g for g in groups if g.type != "revert"]
    if not do_restart:
        groups = [g for g in groups if g.type != "restart"]

    executed_count = sum(1 for g in groups if proc.execute(g, run_ctx))
    logging.info("[v2] Executed action groups: %d", executed_count)

    # Persist full run state via separate logger
    RunStateLogger().insert_state(ctx=run_ctx, pairs=pairs)
    logging.info("[v2] State logged")

    return signals, pairs
