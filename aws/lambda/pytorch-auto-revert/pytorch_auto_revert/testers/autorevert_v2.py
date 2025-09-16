import logging
from datetime import datetime
from typing import Iterable, List, Tuple

from ..run_state_logger import RunStateLogger
from ..signal import Signal
from ..signal_actions import ActionLogger, SignalActionProcessor, SignalProcOutcome
from ..signal_extraction import SignalExtractor
from ..signal_extraction_types import RunContext


def autorevert_v2(
    workflows: Iterable[str],
    *,
    hours: int = 24,
    repo_full_name: str = "pytorch/pytorch",
    dry_run: bool = False,
    dry_run_restart: bool = False,
    dry_run_revert: bool = False,
    do_restart: bool = True,
    do_revert: bool = True,
) -> Tuple[List[Signal], List[Tuple[Signal, SignalProcOutcome]]]:
    """Run the Signals-based autorevert flow end-to-end.

    - Extracts signals for the specified workflows and window
    - Computes per-signal outcomes, groups actions, enforces dedup/caps, and executes
    - Persists a single HUD-like state row for auditability

    Args:
        workflows: List of workflow names to monitor
        hours: Lookback window in hours
        repo_full_name: Repository name
        dry_run: Legacy flag, sets both dry_run_restart and dry_run_revert if they're False
        dry_run_restart: If True, don't actually restart workflows
        dry_run_revert: If True, don't actually revert commits (currently always record-only)
        do_restart: Enable restart actions
        do_revert: Enable revert actions

    Returns:
        (signals, pairs) for diagnostics and potential external rendering
    """
    workflows = list(workflows)
    ts = datetime.now()

    # Handle backwards compatibility: if dry_run is True and specific flags are False, use dry_run
    if dry_run and not dry_run_restart and not dry_run_revert:
        dry_run_restart = True
        dry_run_revert = True

    logging.info(
        "[v2] Start: workflows=%s hours=%s repo=%s dry_run_restart=%s dry_run_revert=%s",
        ",".join(workflows),
        hours,
        repo_full_name,
        dry_run_restart,
        dry_run_revert,
    )

    # Check for concurrent runs
    logger = ActionLogger()
    can_run, reason = logger.check_concurrent_run(
        repo=repo_full_name, workflows=workflows
    )
    if not can_run:
        logging.warning("[v2] Skipping run: %s", reason)
        return [], []

    # Log run start
    overall_dry_run = dry_run_restart or dry_run_revert
    logger.log_run_start(
        repo=repo_full_name, ts=ts, workflows=workflows, dry_run=overall_dry_run
    )
    logging.info("[v2] Logged run start")

    try:
        extractor = SignalExtractor(
            workflows=workflows, lookback_hours=hours, repo_full_name=repo_full_name
        )
        signals = extractor.extract()
        logging.info("[v2] Extracted %d signals", len(signals))

        # Process signals to outcomes
        pairs: List[Tuple[Signal, SignalProcOutcome]] = []
        for s in signals:
            pairs.append((s, s.process_valid_autorevert_pattern()))

        # Build run context
        run_ctx = RunContext(
            ts=ts,
            repo_full_name=repo_full_name,
            workflows=workflows,
            lookback_hours=hours,
            dry_run_restart=dry_run_restart,
            dry_run_revert=dry_run_revert,
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

        executed_count = 0
        for g in groups:
            if proc.execute(g, run_ctx):
                executed_count += 1
        logging.info("[v2] Executed action groups: %d", executed_count)

        # Persist full run state via separate logger
        RunStateLogger().insert_state(ctx=run_ctx, pairs=pairs)
        logging.info("[v2] State logged")

        return signals, pairs

    except Exception as e:
        logging.error("[v2] Run failed: %s", str(e))
        raise
    finally:
        # Always log run finish
        logger.log_run_finish(
            repo=repo_full_name,
            ts=datetime.now(),
            workflows=workflows,
            dry_run=overall_dry_run,
            notes="",
        )
        logging.info("[v2] Logged run finish")
