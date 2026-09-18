"""Re-run the greenlight reviewer over historical decisions under a new policy.

Takes the CSV that ``python3 -m torchci.greenlight_decisions`` writes, keeps the
rows whose verdict can be held against something that actually landed, samples
them, and re-reviews each sampled pull request under the policy carried by a
pytorch/test-infra pull request or ref. The output is that CSV plus four columns
holding the new verdict.

One arm, one judgement per pull request. The stored ``decision`` came from a
different policy version at a different time, and the reviewer does not always
repeat itself on the same head, so a row where ``decision`` and ``new_decision``
disagree is a pull request to go read rather than a measured policy effect.
README.md says what the output does and does not support.

A sweep spends real money -- roughly $1.33 and ten minutes per sampled pull
request -- so ``--dry-run`` resolves the frame and the sample and prints the
bill without invoking a model.

This module owns the shape of a run: what to replay, in what order, and what the
exit status says about it. ``options`` holds the flags and ``sweep`` holds the
machinery each pull request goes through.
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TYPE_CHECKING

from torchci.greenlight_decisions.rows import format_timestamp
from torchci.greenlight_replay.emit import (
    build_replay_row,
    HARNESS_REASON_PREFIX,
    load_checkpoint,
    matching_entries,
    write_replay_csv,
)
from torchci.greenlight_replay.frame import (
    apply_frame,
    fetch_first_verdicts,
    fetch_landings,
    is_size_gate_decline,
    LAND,
    load_rows,
    rederive_first_landing,
    sample_rows,
)
from torchci.greenlight_replay.options import build_parser
from torchci.greenlight_replay.sweep import (
    ESTIMATED_COST_USD,
    ESTIMATED_MINUTES,
    interrupt_guard,
    open_sweep,
    pr_number,
    preflight,
    run_sweep,
    runs_are_trustworthy,
    Sweep,
)


if TYPE_CHECKING:
    from clickhouse_connect.driver.client import Client


LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_DEGRADED = 3

CHECKPOINT_FILENAME = "checkpoint.jsonl"

MAX_LISTED_PRS = 40

logger = logging.getLogger(__name__)

_SLUG_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def connect() -> Client:
    """Open the ClickHouse client.

    The driver import is deferred so that importing this module -- to inspect the
    parser, or to exercise the orchestration -- does not require
    clickhouse_connect to be installed.
    """
    from torchci.clickhouse import get_clickhouse_client

    return get_clickhouse_client()


def default_output_path(now: datetime) -> str:
    stamp = format_timestamp(now).replace("-", "").replace(":", "")
    return f"greenlight_replay_{stamp}.csv"


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser(__doc__).parse_args(argv)
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, stream=sys.stdout)

    policy_ref = args.policy_ref or str(args.policy_pr)
    label = f"pr-{args.policy_pr}" if args.policy_pr else args.policy_ref
    workdir = Path(args.workdir).expanduser() / _slug(label)
    checkpoint_path = workdir / CHECKPOINT_FILENAME
    output = args.output or default_output_path(datetime.now(timezone.utc))

    try:
        sample, framed_total, funnel = select_sample(args)
    except Exception as exc:
        logger.error("could not build the sample: %s", exc, exc_info=True)
        return EXIT_FAILED
    logger.info("frame: %s", _format_counts(funnel, by_count=False))
    logger.info(
        "sampled %d of %d framed rows with seed %d",
        len(sample),
        framed_total,
        args.seed,
    )
    if not sample:
        logger.error("the frame admitted nothing to replay")
        return EXIT_FAILED

    pending = list(sample)
    if args.resume:
        already = matching_entries(sample, load_checkpoint(checkpoint_path))
        # Skips only what reached a verdict. A row the harness spoiled -- a
        # timeout, a budget trip, an outage -- is the usual reason to resume at
        # all, so re-running it is the point rather than a waste.
        pending = [
            row
            for row in sample
            if not (already.get(pr_number(row)) or {}).get("new_decision")
        ]
        logger.info(
            "resume: skipping %d of %d already judged",
            len(sample) - len(pending),
            len(sample),
        )

    if args.dry_run:
        try:
            preflight(workdir)
        except Exception as exc:
            logger.error("a real sweep would not start: %s", exc, exc_info=True)
            return EXIT_FAILED
        log_plan(sample, pending, policy_ref, args)
        return EXIT_OK

    workdir.mkdir(parents=True, exist_ok=True)
    if not args.resume:
        _rotate_checkpoint(checkpoint_path)

    started = time.monotonic()
    aborted = False
    with interrupt_guard() as interrupted:
        try:
            sweep = open_sweep(
                policy_ref=policy_ref,
                workdir=workdir,
                checkpoint_path=checkpoint_path,
                repo=args.repo,
                parallelism=args.parallelism,
                timeout_s=args.timeout_minutes * 60,
                model=args.model,
                context_window=args.context_window,
                interrupted=interrupted,
            )
        except Exception as exc:
            logger.error("could not prepare the sweep: %s", exc, exc_info=True)
            return EXIT_FAILED
        try:
            run_sweep(sweep, pending, args.parallelism)
        except Exception as exc:
            logger.error("the sweep aborted: %s", exc, exc_info=True)
            aborted = True

    # The checkpoint, not the in-memory results, is what the CSV is built from,
    # so an interrupted or half-crashed sweep still emits every verdict it paid
    # for and a resumed one re-emits the runs it skipped. matching_entries keeps
    # only the entries whose recorded input is this row's input, so a corpus
    # re-exported mid-sweep cannot pair a verdict with a head it never judged.
    results = matching_entries(sample, load_checkpoint(checkpoint_path))
    rows = [
        build_replay_row(row, results[pr_number(row)])
        for row in sample
        if pr_number(row) in results
    ]
    try:
        written = write_replay_csv(output, rows)
    except Exception as exc:
        logger.error("could not write %s: %s", output, exc, exc_info=True)
        return EXIT_FAILED

    log_summary(output, written, sample, results, sweep, time.monotonic() - started)
    if aborted or interrupted.is_set() or not written:
        return EXIT_FAILED
    return EXIT_OK if runs_are_trustworthy(results, sweep.errors) else EXIT_DEGRADED


def select_sample(
    args: argparse.Namespace,
) -> tuple[list[dict[str, str]], int, dict[str, int]]:
    """Load the corpus, frame it, re-derive multi-landing rows, and sample."""
    rows = load_rows(args.input)
    client = connect()
    landings = fetch_landings(client, args.repo)
    first_verdicts = fetch_first_verdicts(client, args.repo)
    framed, funnel = apply_frame(rows, landings, first_verdicts)
    sample = sample_rows(framed, frac=args.sample_frac, n=args.sample_n, seed=args.seed)
    requested = len(sample)
    # Re-deriving after sampling rather than before draws the identical sample --
    # the draw is by index over the framed list, which re-derivation leaves in
    # place -- while paying for only the rows that will be replayed. Each costs a
    # decision query and two compare calls, and a LookupError on a row nobody
    # sampled would otherwise fail the whole run, dry runs included.
    sample, declined = rederive_multi_landing(client, args.repo, sample, landings)
    if declined:
        # apply_frame settles the gate only for rows whose verdict is final, so a
        # multi-landing row reaches its canned decline only once re-derived.
        funnel["size_gate"] += declined
        logger.info(
            "%d of %d sampled rows were size-gate declines at their first landing",
            declined,
            requested,
        )
    return sample, len(framed), funnel


def rederive_multi_landing(
    client: Client,
    repo: str,
    rows: Sequence[dict[str, str]],
    landings: Mapping[int, Sequence[Any]],
) -> tuple[list[dict[str, str]], int]:
    """Restate the rows of pull requests whose code reached main more than once.

    Such a row's verdict is the one the export selected against the PR's final
    head, which here names a later landing than the one being replayed. The
    first landing is what the policy under test is asked about, so the decision
    columns are re-derived as of that instant -- the earliest event of kind
    ``land``, since a revert can sort ahead of it.
    """
    rederived: list[dict[str, str]] = []
    declined = 0
    for row in rows:
        lands = [
            event for event in landings.get(pr_number(row), ()) if event.kind == LAND
        ]
        if len(lands) > 1:
            restated = rederive_first_landing(
                client, repo, dict(row), min(event.ts for event in lands)
            )
            # The canned decline came from a byte comparison with no model in it,
            # so replaying it would measure the cap rather than the policy.
            if is_size_gate_decline(restated):
                declined += 1
                continue
            rederived.append(restated)
        else:
            rederived.append(dict(row))
    return rederived, declined


def log_plan(
    sample: Sequence[Mapping[str, str]],
    pending: Sequence[Mapping[str, str]],
    policy_ref: str,
    args: argparse.Namespace,
) -> None:
    logger.info(
        "dry run: no model is invoked and nothing is written. The scratch root "
        "and the reviewer's binaries are checked; the policy is not fetched, so "
        "nothing here says it parses or which model it resolves to"
    )
    logger.info(
        "policy %s, model %s",
        policy_ref,
        args.model or "resolved from the policy at run time",
    )
    logger.info(
        "%d sampled, %d to run: %s", len(sample), len(pending), _pr_list(pending)
    )
    logger.info(
        "estimated $%.2f and %.0f min of wall clock at parallelism %d",
        len(pending) * ESTIMATED_COST_USD,
        len(pending) * ESTIMATED_MINUTES / args.parallelism,
        args.parallelism,
    )


def log_summary(
    output: str,
    written: int,
    sample: Sequence[Mapping[str, str]],
    results: Mapping[int, Mapping[str, Any]],
    sweep: Sweep,
    elapsed_s: float,
) -> None:
    logger.info("wrote %d rows to %s in %.1f min", written, output, elapsed_s / 60)
    verdicts = Counter(
        entry.get("new_decision") or "(none)" for entry in results.values()
    )
    logger.info("new_decision: %s", _format_counts(verdicts))
    spoiled = Counter(
        entry["new_decision_reason"]
        for entry in results.values()
        if entry.get("new_decision_reason", "").startswith(HARNESS_REASON_PREFIX)
    )
    if spoiled:
        logger.warning("runs the harness spoiled: %s", _format_counts(spoiled))
    if sweep.errors:
        logger.warning(
            "%d pull requests never reached the reviewer and carry no row: %s",
            len(sweep.errors),
            _format_counts(Counter(name for _, name in sweep.errors)),
        )
    unrun = len(sample) - len(results) - len(sweep.errors)
    if unrun > 0:
        logger.warning("%d sampled pull requests were never started", unrun)
    # Read back out of the checkpoint rather than tallied in memory, so a resumed
    # sweep reports what the whole sample cost and not only what this run added.
    costs = [
        entry["cost_usd"]
        for entry in results.values()
        if isinstance(entry.get("cost_usd"), (int, float))
    ]
    logger.info("$%.2f over %d of %d runs", sum(costs), len(costs), len(results))
    if not runs_are_trustworthy(results, sweep.errors):
        logger.error(
            "more than half the attempted runs reached no verdict; the "
            "new_decision columns describe the harness, not the policy"
        )


def _rotate_checkpoint(path: Path) -> None:
    """Move a previous sweep's checkpoint aside so its verdicts are not reused.

    Named to the nanosecond: ``rename`` overwrites silently, and two sweeps
    started in the same second would otherwise cost one of them its record.
    """
    if not path.exists():
        return
    rotated = path.with_name(f"{path.name}.{time.time_ns()}")
    path.rename(rotated)
    logger.info("moved the existing checkpoint aside to %s", rotated)


def _pr_list(rows: Sequence[Mapping[str, str]]) -> str:
    numbers = [str(row.get("pr_number")) for row in rows]
    if len(numbers) <= MAX_LISTED_PRS:
        return ", ".join(numbers) or "(none)"
    head = ", ".join(numbers[:MAX_LISTED_PRS])
    return f"{head}, and {len(numbers) - MAX_LISTED_PRS} more"


def _format_counts(counts: Mapping[str, int], *, by_count: bool = True) -> str:
    ordered: list[tuple[str, int]] = list(counts.items())
    if by_count:
        ordered.sort(key=lambda item: (-item[1], item[0]))
    return ", ".join(f"{name}={count}" for name, count in ordered) or "(none)"


def _slug(ref: str) -> str:
    return _SLUG_UNSAFE.sub("-", ref).strip("-") or "policy"


if __name__ == "__main__":
    sys.exit(main())
