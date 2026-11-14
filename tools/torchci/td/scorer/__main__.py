"""CLI: `python -m torchci.td.scorer refit --day YYYY-MM-DD --out td-scorer.json`.

`refit` fits each test config's start-up per file on the week before the refit day
(start_up.py) and exits 1 when fewer than start_up.MIN_ACCEPTED_CONFIGS have one, builds
missing day shards, fits the scorer and the risk score on the healthy days of the last
year (train.WINDOW_DAYS) whose jobs have finished, runs the walk-forward months and the
gate (gate.py) and writes the model files: `--out` never carries a budget block, and
`--budget-out` is the model as it ships, the same file unless it kept a block; `--sample`
and `--budget-sample` are their sample rows. It exits 1 when the gate fails; when no
training or gate day is healthy; when anything raises (the walk-forward decides the
gate); and, with `--s3`, when a gate day was not built soundly (a fetch or the build
failed, or it has no outcomes). With `--report-only`, neither the gate nor the days fail
it. With `--budget`, every model carries model_json.BUDGET as its budget block, and the
shipped model keeps it only when the gate's budget check passes; refit then writes the
models and the samples after the walk-forward and, last, prints the report-only
main-failure monitor (gate.monitor, which waits at most gate.MONITOR_SECONDS): main
landings of the last two months caught by the budgeted cut and by TD's 25% cut.
Once the models and the samples are written, and when a candidate heuristic
(train.CANDIDATES) was logged, refit also prints, report only, the walk-forward with the
candidates added (walkforward.candidates) and adds it to `--report`; an error there is
logged and changes nothing else.
`check-pytorch` checks a model file against pytorch's TD scorer code (check_pytorch.py).
`sweep` replays the cut at every point of the budget grid, read-only (sweep.py).
"""

import argparse
import json
import logging
import resource
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from torchci.td.scorer import (
    check_pytorch,
    gate,
    holdout,
    logs,
    model_json,
    rows,
    sample,
    start_up,
    store,
    sweep,
    train,
    walkforward,
)


logger = logging.getLogger(__name__)

FINAL_AFTER_DAYS = 2
TEST_TIMES_URL = (
    "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/"
    "test-times.json"
)


def _store(
    args: argparse.Namespace, prefix: str = store.S3_PREFIX, subdir: str = ""
) -> Optional[store.ShardStore]:
    if args.s3:
        return store.S3Store(prefix=prefix)
    if args.cache_dir:
        return store.DirStore(Path(args.cache_dir) / subdir)
    return None


def fetch_test_times() -> dict[str, Any]:
    body = logs.http_get(TEST_TIMES_URL)
    if body is None:
        raise RuntimeError(f"{TEST_TIMES_URL} not found")
    data = json.loads(body)
    if not isinstance(data, dict):
        raise RuntimeError(f"{TEST_TIMES_URL} is not a JSON object")
    return data


def shipped_cutoff(day: date, today: date, first_gate_day: date) -> date:
    """The day before which the shipped model is fitted: the refit day, but no day whose
    jobs may still run, and never before the gate window."""
    return max(first_gate_day, min(day, today - timedelta(days=FINAL_AFTER_DAYS)))


def write_models(args: argparse.Namespace, model: dict[str, Any]) -> None:
    Path(args.out).write_text(model_json.dumps(model_json.without_budget(model)))
    if args.budget_out:
        Path(args.budget_out).write_text(model_json.dumps(model))


def report_candidates(
    args: argparse.Namespace,
    history: walkforward.History,
    source: store.Shards,
    times: rows.JobTimes,
    summary: dict[str, Any],
) -> None:
    """Report only: when a candidate heuristic was logged, prints the walk-forward with
    the candidates added (walkforward.candidates) and, with `--report`, adds it to the
    report under `candidates`. Never raises."""
    if not history.candidate_prs:
        return
    try:
        compared = walkforward.candidates(history, source.get, times, args.day)
        print(walkforward.candidates_text(*compared))
        if args.report and compared[0]:
            summary["candidates"] = walkforward.candidates_summary(*compared)
            Path(args.report).write_text(json.dumps(summary, indent=2) + "\n")
    except Exception as e:
        logger.error("candidates report failed: %s", e, exc_info=True)
        print(f"candidates (report only): unavailable ({type(e).__name__}: {e})")


def refit(args: argparse.Namespace) -> int:
    day = date.fromisoformat(args.day)
    today = datetime.now(timezone.utc).date()
    train_days = train.training_days(day, args.train_days, args.gate_days)
    gate_days = train.gate_days(day, args.gate_days)
    source = store.Shards(
        _store(args),
        today - timedelta(days=FINAL_AFTER_DAYS),
        today - timedelta(days=train.GATE_DAYS),
    )
    start_up_fits = start_up.fit_all(start_up.fetch(day))
    print(start_up.text(start_up_fits))
    start_up_table = start_up.table(start_up_fits)
    if start_up.size(start_up_table) < start_up.MIN_ACCEPTED_CONFIGS:
        print(
            f"only {start_up.size(start_up_table)} configs have a start-up (needs >="
            f" {start_up.MIN_ACCEPTED_CONFIGS})"
        )
        if not args.report_only:
            return 1
        print("report only: continuing")
    source.ensure(train_days + gate_days)
    if source.gaps:
        print(
            f"{len(source.gaps)} days with TD logs missing or no outcomes, left out:"
            f" {sorted(source.gaps)}"
        )
    if source.unhealthy:
        print(f"unhealthy days, left out: {sorted(source.unhealthy)}")
        gate_keys = {d.isoformat() for d in gate_days}
        if args.s3 and not args.report_only and set(source.unhealthy) & gate_keys:
            return 1
    if source.missing:
        print(
            f"{len(source.missing)} days still missing (the backfill ran out of time),"
            f" left out: {source.missing[-1]}..{source.missing[0]}"
        )
    train_days, gate_days = source.usable(train_days), source.usable(gate_days)
    if not train_days or not gate_days:
        print("no healthy training or gate days")
        return 0 if args.report_only else 1
    held = holdout.load_or_build(_store(args, holdout.HOLDOUT_PREFIX, "holdout"))
    if not holdout.holdout_ok(held):
        print(f"the holdout set is unsound (reported only): {held.meta}")
    times = rows.JobTimes(fetch_test_times(), start_up_table)

    history = walkforward.assemble(
        source.get, train_days + gate_days, {r.pr for r in held.runs}, times, day
    )
    shipped_before = shipped_cutoff(day, today, gate_days[0])
    print(
        f"days: {len(train_days)} training, {len(gate_days)} gate; the shipped model"
        f" is fitted on the days before {shipped_before}"
    )
    budget = model_json.BUDGET if args.budget else None
    fit = history.fit(shipped_before, set(), day.isoformat(), budget)
    print(f"training: {fit.text()}")
    model = fit.model
    if budget is None:
        write_models(args, model)

    started = time.monotonic()
    folds = walkforward.walk_forward(
        history, source.get, times, day.isoformat(), budget
    )
    print(walkforward.text(folds))
    result = gate.Gate.pooled(
        holdout.evaluate_holdout(model, held, times),
        [f.report for f in folds],
        args.floor_ratio,
        budget,
    )
    print(result.text())
    peak_gb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20
    print(
        f"walk-forward {time.monotonic() - started:.0f} s for {len(folds)} months,"
        f" peak RSS {peak_gb:.2f} GB"
    )
    summary: dict[str, Any] = {}
    if budget is not None:
        candidate, model = model, gate.settle_budget(model, result)
        summary["budget_kept"] = "budget" in model
        write_models(args, model)
    if args.report:
        summary = {
            **result.summary(),
            **summary,
            "walk_forward": walkforward.summary(folds),
        }
        Path(args.report).write_text(json.dumps(summary, indent=2) + "\n")
    texts: dict[bool, str] = {}
    for path, m in (
        (args.sample, model_json.without_budget(model)),
        (args.budget_sample, model),
    ):
        if not path:
            continue
        has_block = "budget" in m
        if has_block not in texts:
            sampled = sample.sample_model(
                m, (source.get(d) for d in reversed(gate_days)), times
            )
            texts[has_block] = json.dumps(sampled.dump()) + "\n"
        Path(path).write_text(texts[has_block])
    report_candidates(args, history, source, times, summary)
    if budget is not None:
        gate.monitor(candidate, times, day)
    if result.passed:
        return 0
    if args.report_only:
        print("report only: the gate result does not fail this run")
        return 0
    return 1


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m torchci.td.scorer")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("refit", help="build shards, fit, gate and write the model")
    p.add_argument("--day", default=datetime.now(timezone.utc).date().isoformat())
    p.add_argument("--out", required=True)
    p.add_argument(
        "--train-days",
        type=int,
        help="only the last N training days (default: a year with the gate days,"
        " train.WINDOW_DAYS)",
    )
    p.add_argument("--gate-days", type=int, default=train.GATE_DAYS)
    p.add_argument("--s3", action="store_true", help="read and write S3 day shards")
    p.add_argument("--cache-dir", help="a local directory of day shards instead of S3")
    p.add_argument("--report", help="write the gate summary as JSON")
    p.add_argument("--sample", help="write sample rows for check-pytorch")
    p.add_argument(
        "--budget-out",
        help="also write the model as it ships: with its budget block when it kept"
        " one, else the same as --out",
    )
    p.add_argument("--budget-sample", help="write --budget-out's sample rows")
    p.add_argument("--floor-ratio", type=float, default=gate.FLOOR_RATIO)
    p.add_argument(
        "--budget",
        action="store_true",
        help="give the models model_json.BUDGET as their budget block, kept when the"
        " gate's budget check passes",
    )
    p.add_argument(
        "--report-only",
        action="store_true",
        help="print the gate report and exit 0 whatever the gate's result",
    )
    p.set_defaults(func=refit)
    check_pytorch.add_parser(sub)
    sweep.add_parser(sub)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
