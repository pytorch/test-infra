"""CLI: `python -m torchci.td.scorer refit --day YYYY-MM-DD --out td-scorer.json`.

`refit` builds missing day shards, fits the scorer and the risk score on every healthy
day before the gate window, runs the walk-forward months and the gate (gate.py) and
writes the model file. It exits 1 when the gate fails; when no training or gate day is
healthy; when anything raises (the walk-forward decides the gate); and, with `--s3`,
when a gate day was not built soundly (a fetch or the build failed, or it has no
outcomes) or the holdout set is unsound. With `--report-only`, neither the gate nor the
days fail it.
`check-pytorch` validates a model with pytorch's scorer_model.py, compares its p and r
with the trainer's and replays the gate's cut with pytorch's select_tests, on a sample
written by `refit --sample`; it exits 0 when all of that ran and matched, SKIPPED when
pytorch lacks the scorer code, else 1.
"""

import argparse
import importlib.util
import json
import logging
import math
import resource
import sys
import time
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from torchci.td.scorer import (
    gate,
    holdout,
    logs,
    model_json,
    rows,
    store,
    train,
    trunk,
    walkforward,
)


logger = logging.getLogger(__name__)

FINAL_AFTER_DAYS = 2
MAX_DIFF = 1e-6
SKIPPED = 3
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
        print(f"the holdout set is unsound: {held.meta}")
        if args.s3:
            return 1
    times = rows.JobTimes(fetch_test_times())

    history = walkforward.History(times, {r.pr for r in held.runs})
    for d in train_days + gate_days:
        history.add_shard(d, source.get(d))
    landings = trunk.fetch_landings(
        datetime.combine(train_days[0], datetime.min.time()),
        datetime.combine(day, datetime.min.time()),
    )
    head_logs = trunk.fetch_head_logs(p.head_sha for x in landings for p in x.pairs)
    history.finish(landings, head_logs)
    print(f"days: {len(train_days)} training, {len(gate_days)} gate")
    fit = history.fit(gate_days[0], set(), day.isoformat())
    print(f"training: {fit.text()}")
    model = fit.model
    Path(args.out).write_text(model_json.dumps(model))

    started = time.monotonic()
    folds = walkforward.walk_forward(history, source.get, times, day.isoformat())
    print(walkforward.text(folds))
    result = gate.Gate.pooled(
        holdout.evaluate_holdout(model, held, times),
        [f.report for f in folds],
        args.floor_ratio,
    )
    print(result.text())
    peak_gb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20
    print(
        f"walk-forward {time.monotonic() - started:.0f} s for {len(folds)} months,"
        f" peak RSS {peak_gb:.2f} GB"
    )
    if args.report:
        summary = {**result.summary(), "walk_forward": walkforward.summary(folds)}
        Path(args.report).write_text(json.dumps(summary, indent=2) + "\n")
    if args.sample:
        sample = gate.sample_model(
            model, (source.get(d) for d in reversed(gate_days)), times
        )
        Path(args.sample).write_text(json.dumps(asdict(sample)) + "\n")
    if result.passed:
        return 0
    if args.report_only:
        print("report only: the gate result does not fail this run")
        return 0
    return 1


SCORER_DIR = Path("tools/testing/target_determination")


def _load_pytorch(module_path: Path) -> Optional[Any]:
    if not module_path.exists():
        return None
    spec = importlib.util.spec_from_file_location(
        "pytorch_td_scorer_model", module_path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _replay_cuts(root: Path, model: Any, jobs: list[dict[str, Any]]) -> Optional[int]:
    """Jobs whose selection by pytorch's select_tests differs from the gate's; None
    when pytorch has no scorer.py or its scorer.py has no select_tests."""
    if not (root / SCORER_DIR / "scorer.py").exists():
        return None
    sys.path.insert(0, str(root))
    try:
        from tools.testing.target_determination import scorer  # type: ignore[import]
        from tools.testing.test_run import TestRun  # type: ignore[import]
    finally:
        sys.path.remove(str(root))
    if getattr(scorer, "select_tests", None) is None:
        return None
    mismatches = 0
    for job in jobs:
        block = {
            "model": model,
            "heuristics": job["heuristics"],
            "raised": job["raised"],
        }
        selected, _, _ = scorer.select_tests(
            block,
            [TestRun(f) for f in job["include"]],
            [TestRun(f) for f in job["exclude"]],
            job["times"],
            job["build_env"],
            job["test_config"],
        )
        mismatches += sorted({t.test_file for t in selected}) != job["selected"]
    return mismatches


def check_pytorch(args: argparse.Namespace) -> int:
    root = Path(args.pytorch_root)
    module = _load_pytorch(root / SCORER_DIR / "scorer_model.py")
    if module is None:
        print(
            f"SKIP: no {SCORER_DIR}/scorer_model.py in {root} (pytorch main does not have"
            " the TD scorer yet); the model was not checked against pytorch's validator"
        )
        return SKIPPED
    raw = Path(args.model).read_bytes()
    model = module.parse_model(raw)
    sample = json.loads(Path(args.sample).read_text())
    diffs = [
        module.file_probability(
            model,
            row["scores"],
            row["cost"],
            row["build_env"],
            row["test_config"],
            row["raised"],
        )
        - row["p"]
        for row in sample["p"]
    ]
    diffs += [
        module.risk_score(model, row["features"]) - row["r"] for row in sample["r"]
    ]
    if not diffs:
        print("FAIL: empty sample")
        return 1
    if not all(math.isfinite(d) for d in diffs):
        print("FAIL: a p or r difference is not finite")
        return 1
    worst = max(abs(d) for d in diffs)
    print(
        f"pytorch validator: ok; max |diff| of p and r over {len(diffs)} rows:"
        f" {worst:.3g}"
    )
    if worst > MAX_DIFF:
        print(f"FAIL: p or r differ from pytorch's by more than {MAX_DIFF}")
        return 1
    jobs = sample.get("jobs", [])
    mismatches = _replay_cuts(root, model, jobs)
    if mismatches is None:
        print(
            f"SKIP: no {SCORER_DIR}/scorer.py with select_tests: the cut was not"
            " replayed in pytorch"
        )
        return SKIPPED
    print(f"pytorch select_tests: {mismatches} of {len(jobs)} jobs select differently")
    return 0 if jobs and not mismatches else 1


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m torchci.td.scorer")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("refit", help="build shards, fit, gate and write the model")
    p.add_argument("--day", default=datetime.now(timezone.utc).date().isoformat())
    p.add_argument("--out", required=True)
    p.add_argument(
        "--train-days",
        type=int,
        help="only the last N training days (default: every day from the first day"
        " of data)",
    )
    p.add_argument("--gate-days", type=int, default=train.GATE_DAYS)
    p.add_argument("--s3", action="store_true", help="read and write S3 day shards")
    p.add_argument("--cache-dir", help="a local directory of day shards instead of S3")
    p.add_argument("--report", help="write the gate summary as JSON")
    p.add_argument("--sample", help="write sample rows for check-pytorch")
    p.add_argument("--floor-ratio", type=float, default=gate.FLOOR_RATIO)
    p.add_argument(
        "--report-only",
        action="store_true",
        help="print the gate report and exit 0 whatever the gate's result",
    )
    p.set_defaults(func=refit)
    c = sub.add_parser(
        "check-pytorch", help="check a model with pytorch's scorer_model.py"
    )
    c.add_argument("--model", required=True)
    c.add_argument("--sample", required=True)
    c.add_argument(
        "--pytorch-root",
        required=True,
        help="a pytorch checkout holding at least tools/testing and tools/stats",
    )
    c.set_defaults(func=check_pytorch)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
