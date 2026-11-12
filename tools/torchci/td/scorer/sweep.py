"""The budget sweep: a read-only replay of the scorer's cut at every point of a grid.

It reads day shards and the holdout set from a local cache directory (never S3; a missing
shard or holdout set fails the run before anything is written, and the store refuses
writes), test times and each config's start-up (the start_up_seconds of a model file,
--start-up, else --model's) from files whose sha256 it records, and new, confirmed main
failures (main_failures.py) from a local cache file of exactly the run's window, fetched
read-only and saved there when the file is absent.

Each walk-forward month (walkforward.folds) is scored by the model fitted on the days
before it, or every day by the --model file. Each job is prepared once, ranked once per
order and filled once per budget (cut.job_budget). The --orders are p / cost ** a for
numbers a, and "td", TD's own aggregated ranking at the same budgets; a point (order,
spread, base) is the budget block {"share": base, "spread": spread, "cost_exponent": a},
skipped when pytorch's validator would reject it.

A job whose config has no start-up keeps TD's include list at every point, and only
served jobs count toward the realised share and the retention, as in the gate. Per
point, one JSON row: the realised share of the jobs' cost and of their test-times
seconds (ratios of sums over the 1 in cut.SHARE_SAMPLE hash sample of served jobs); main
landings and failures caught (a landing when any of its failures is in the cut), each
landing scored by its month's model, with TD's 25% cut on the same jobs as reference;
per-PR and per-event retention of TD's PR catches (cut.window_jobs' events inside TD's
include list); and holdout catches by the model fitted before holdout.HOLDOUT_START.
The .npz next to the JSON holds per-landing and per-PR vectors for bootstraps, with each
landing's and PR's r and budget mode (a landing's from a served unit when it has one).
"""

import argparse
import json
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Optional, Sequence, Union

import numpy as np
from torchci.td.scorer import (
    holdout,
    main_failures,
    model_json,
    store,
    sweep_inputs,
    train,
)
from torchci.td.scorer.cut import (
    Evaluator,
    fill,
    Job,
    job_budget,
    must_run_files,
    NO_START_UP,
    rank,
    rank_by,
    Ranking,
    share_sampled,
    window_jobs,
)
from torchci.td.scorer.rows import JobTimes
from torchci.td.scorer.shards import DayShard, Run, Unit
from torchci.td.scorer.walkforward import assemble, folds, next_month


COST_EXPONENTS = (0.25, 0.5, 0.75, 1.0)
TD_ORDER = "td"
SPREADS = (0.0, 0.25, 0.5, 0.75)
BASES = (0.10, 0.125, 0.15, 0.175, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50)
ORDERS = (*COST_EXPONENTS, TD_ORDER)

Order = Union[float, str]


@dataclass(frozen=True)
class Point:
    order: Order
    spread: float
    base: float

    def block(self) -> dict[str, float]:
        a = 1.0 if self.order == TD_ORDER else float(self.order)
        return {"share": self.base, "spread": self.spread, "cost_exponent": a}


def grid(
    orders: Sequence[Order] = ORDERS,
    spreads: Sequence[float] = SPREADS,
    bases: Sequence[float] = BASES,
) -> list[Point]:
    points = [Point(o, k, s) for o in orders for k in spreads for s in bases]
    return [p for p in points if model_json.valid_budget(p.block())]


def parse_orders(text: str) -> list[Order]:
    return [x if x == TD_ORDER else float(x) for x in text.split(",")]


def parse_floats(text: str) -> list[float]:
    return [float(x) for x in text.split(",")]


class Scorer:
    """One model's cut of a job at every point."""

    def __init__(
        self, model: dict[str, Any], times: JobTimes, points: list[Point]
    ) -> None:
        self.ev, self.points = Evaluator(model, times), points

    def cuts(self, run: Run, unit: Unit) -> tuple[Job, list[set[str]], str]:
        """The job, its cut at every point, and its budget mode (the same at every point:
        it depends on the change only)."""
        job = self.ev.prepare(run, unit)
        if not job.served:
            return job, [set(job.include)] * len(self.points), NO_START_UP
        orders: dict[Order, Ranking] = {}
        filled: dict[tuple[Order, int], set[str]] = {}
        out, mode = [], ""
        for point in self.points:
            budget = job_budget({"budget": point.block()}, job)
            mode = budget["mode"]
            a = budget["cost_exponent"]
            key = (TD_ORDER if point.order == TD_ORDER else a, budget["budget_ms"])
            if key not in filled:
                order = key[0]
                if order not in orders:
                    orders[order] = (
                        rank_by(job.files, run.aggregated, job.must_run)
                        if order == TD_ORDER
                        else rank(job.files, job.p, job.costs, job.must_run, a)
                    )
                filled[key] = fill(orders[order], job.ms, key[1], True)
            out.append(filled[key])
        return job, out, mode


@dataclass
class Tally:
    n: int
    share_jobs: int = 0
    total_ms: int = 0
    total_seconds: float = 0.0
    cost_ms: np.ndarray = field(init=False)
    seconds: np.ndarray = field(init=False)
    events_inside: int = 0
    events_kept: np.ndarray = field(init=False)
    pr_kept: dict[int, np.ndarray] = field(default_factory=dict)
    pr_info: dict[int, tuple[str, float, str]] = field(default_factory=dict)
    landings: list[tuple[str, str, int, int, float, str]] = field(default_factory=list)
    landing_caught: list[np.ndarray] = field(default_factory=list)
    holdout_events: int = 0
    holdout_td: int = 0
    holdout_caught: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.cost_ms, self.seconds = np.zeros(self.n, np.int64), np.zeros(self.n)
        self.events_kept = np.zeros(self.n, np.int64)
        self.holdout_caught = np.zeros(self.n, np.int64)

    def add_share(self, job: Job, cuts: list[set[str]]) -> None:
        self.share_jobs += 1
        self.total_ms += job.total_ms
        self.total_seconds += job.seconds(set(job.files))
        self.cost_ms += [job.used_ms(c) for c in cuts]
        self.seconds += [job.seconds(c) for c in cuts]


def _r(job: Job) -> float:
    return float("nan") if job.r is None else job.r


def score_prs(
    scorer: Scorer, shards: Any, prs: set[int], month: str, tally: Tally
) -> None:
    for wj in window_jobs(shards, prs):
        sampled = share_sampled(wj.run.run_id, wj.unit.build_env, wj.unit.test_config)
        if not wj.new and not sampled:
            continue
        job, cuts, mode = scorer.cuts(wj.run, wj.unit)
        if sampled and job.served:
            tally.add_share(job, cuts)
        inside = [f for f in wj.new if f in job.include] if job.served else []
        if not inside:
            continue
        hits = np.array([sum(f in c for f in inside) for c in cuts])
        tally.events_inside += len(inside)
        tally.events_kept += hits
        kept = tally.pr_kept.setdefault(wj.run.pr, np.zeros(tally.n, bool))
        kept |= hits > 0
        tally.pr_info.setdefault(wj.run.pr, (month, _r(job), mode))


def score_landings(
    scorer: Scorer,
    landings: list[main_failures.MainLanding],
    month: str,
    tally: Tally,
) -> None:
    change: dict[str, tuple[float, str]] = {}

    def select(run: Run, unit: Unit) -> list[set[str]]:
        job, cuts, mode = scorer.cuts(run, unit)
        if job.served or run.head_sha not in change:
            change[run.head_sha] = (_r(job), mode)
        return [*cuts, job.include]

    for landing, caught, failures in main_failures.landings_caught(landings, select):
        r, mode = change.get(landing.landing_sha, (float("nan"), ""))
        sha = landing.landing_sha
        tally.landings.append((sha, month, failures, caught[-1], r, mode))
        tally.landing_caught.append(np.array(caught[:-1]))


def score_holdout(scorer: Scorer, held: DayShard, tally: Tally) -> None:
    for run, unit, first in holdout.first_events(held):
        new = [f for f in first if f not in must_run_files(run)]
        if not new:
            continue
        job, cuts, _ = scorer.cuts(run, unit)
        tally.holdout_events += len(new)
        tally.holdout_td += sum(f in job.include for f in new)
        tally.holdout_caught += [sum(f in c for f in new) for c in cuts]


def _ratio(a: Any, b: Any) -> Any:
    return np.where(b > 0, a / np.maximum(b, 1), np.nan)


def rows(points: list[Point], t: Tally) -> list[dict[str, Any]]:
    caught = np.array(t.landing_caught).reshape(len(t.landings), t.n)
    failures = np.array([x[2] for x in t.landings], np.int64)
    td = np.array([x[3] for x in t.landings], np.int64)
    kept = np.array(list(t.pr_kept.values())).reshape(len(t.pr_kept), t.n)
    columns = {
        "cost_share": _ratio(t.cost_ms, t.total_ms),
        "seconds_share": _ratio(t.seconds, t.total_seconds),
        "main_landings_caught": (caught > 0).sum(axis=0),
        "main_failures_caught": caught.sum(axis=0),
        "retention_kept": kept.sum(axis=0),
        "retention": _ratio(kept.sum(axis=0), len(t.pr_kept)),
        "events_kept": t.events_kept,
        "event_retention": _ratio(t.events_kept, t.events_inside),
        "holdout_caught": t.holdout_caught,
    }
    common = {
        "share_jobs": t.share_jobs,
        "main_landings": len(t.landings),
        "main_failures": int(failures.sum()),
        "td_main_landings_caught": int((td > 0).sum()),
        "td_main_failures_caught": int(td.sum()),
        "retention_prs": len(t.pr_kept),
        "events_inside": t.events_inside,
        "holdout_events": t.holdout_events,
        "holdout_td_caught": t.holdout_td,
    }
    return [
        {
            **asdict(p),
            **common,
            **{k: v[i].item() for k, v in columns.items()},
        }
        for i, p in enumerate(points)
    ]


def save_vectors(path: Path, points: list[Point], t: Tally) -> None:
    np.savez_compressed(
        path,
        points=np.array([[str(p.order), p.spread, p.base] for p in points], dtype=str),
        landing_sha=np.array([x[0] for x in t.landings], dtype=str),
        landing_month=np.array([x[1] for x in t.landings], dtype=str),
        landing_failures=np.array([x[2] for x in t.landings], np.int64),
        landing_td_caught=np.array([x[3] for x in t.landings], np.int64),
        landing_caught=np.array(t.landing_caught, np.int64).reshape(-1, t.n),
        landing_r=np.array([x[4] for x in t.landings], float),
        landing_mode=np.array([x[5] for x in t.landings], dtype=str),
        pr=np.array(list(t.pr_kept), np.int64),
        pr_month=np.array([t.pr_info[pr][0] for pr in t.pr_kept], dtype=str),
        pr_r=np.array([t.pr_info[pr][1] for pr in t.pr_kept], float),
        pr_mode=np.array([t.pr_info[pr][2] for pr in t.pr_kept], dtype=str),
        pr_kept=np.array(list(t.pr_kept.values()), bool).reshape(-1, t.n),
    )


def sweep(args: argparse.Namespace) -> int:
    problem = sweep_inputs.bad_args(args)
    if problem is not None:
        print(f"FAIL: {problem}; nothing written")
        return 1
    day = date.fromisoformat(args.day)
    gate_days = train.gate_days(day, args.gate_days)
    days = gate_days
    if args.model is None:
        days = train.training_days(day, args.train_days, args.gate_days) + gate_days
    shards = sweep_inputs.ReadOnlyDirStore(Path(args.cache_dir))
    gaps = [d for d in days if shards.exists(f"{d.isoformat()}{store.GAP_SUFFIX}")]
    days = [d for d in days if d not in gaps]
    missing = [d.isoformat() for d in days if not shards.exists(d.isoformat())]
    held_data = sweep_inputs.ReadOnlyDirStore(Path(args.cache_dir) / "holdout").get(
        holdout.HOLDOUT_KEY
    )
    if missing or held_data is None or not days:
        print(f"FAIL: no shard for {missing}, or no holdout set; nothing written")
        return 1
    held = store.load_shard(held_data)
    table_file = str(args.start_up or args.model)
    table = json.loads(Path(table_file).read_text())["start_up_seconds"]
    times = JobTimes(json.loads(Path(args.test_times).read_text()), table)

    def load(d: date) -> DayShard:
        data = shards.get(d.isoformat())
        assert data is not None
        return store.load_shard(data)

    version = day.isoformat()
    held_prs = {r.pr for r in held.runs}
    if args.model is not None:
        model = json.loads(Path(args.model).read_text())
        prs = set().union(*({r.pr for r in load(d).runs} for d in days))
        windows = [(days[0], day, model, prs, days)]
        before_holdout: Optional[dict[str, Any]] = model
    else:
        history = assemble(load, days, held_prs, times, day)
        windows = []
        for f in folds(history):
            fit = history.fit(f.month, f.prs, version).model
            windows.append((f.month, next_month(f.month), fit, f.new_prs, f.days))
        before_holdout = None
        if days[0] < holdout.HOLDOUT_START:
            before_holdout = history.fit(holdout.HOLDOUT_START, set(), version).model
    if not windows:
        print("FAIL: no walk-forward month (the first needs a month of training days)")
        return 1
    landings, counts = sweep_inputs.main_landings(Path(args.main_cache), days[0], day)
    points = grid(args.orders, args.spreads, args.bases)
    tally = Tally(len(points))
    for start, stop, model, prs, window_days in windows:
        scorer = Scorer(model, times, points)
        month = start.isoformat()[:7]
        score_prs(scorer, (load(d) for d in window_days), prs, month, tally)
        in_window = [
            x for x in landings if start.isoformat() <= x.day[:10] < stop.isoformat()
        ]
        score_landings(scorer, in_window, month, tally)
    if before_holdout is not None:
        score_holdout(Scorer(before_holdout, times, points), held, tally)
    meta = {
        "day": version,
        "days": len(days),
        "gap_days": [d.isoformat() for d in gaps],
        "windows": [w[0].isoformat()[:7] for w in windows],
        "model": None if args.model is None else sweep_inputs.file_record(args.model),
        "test_times": sweep_inputs.file_record(args.test_times),
        "start_up": sweep_inputs.file_record(table_file),
        "main_cache": {"path": args.main_cache, "counts": counts, "n": len(landings)},
        "holdout_prs": len(held_prs),
    }
    Path(args.out).write_text(json.dumps({"meta": meta, "rows": rows(points, tally)}))
    save_vectors(Path(args.out).with_suffix(".npz"), points, tally)
    print(
        f"sweep: {len(points)} points over {len(windows)} windows,"
        f" {len(tally.landings)} main landings, {len(tally.pr_kept)} PRs: {args.out};"
        f" main-failure counts {counts}"
    )
    return 0


def add_parser(sub: Any) -> None:
    s = sub.add_parser("sweep", help="replay the cut at every budget grid point")
    s.add_argument("--day", required=True, help="as refit's --day")
    s.add_argument("--train-days", type=int)
    s.add_argument("--gate-days", type=int, default=train.GATE_DAYS)
    s.add_argument("--cache-dir", required=True, help="refit's --cache-dir, read only")
    s.add_argument("--test-times", required=True, help="a test-times.json file")
    s.add_argument("--main-cache", required=True, help="main landings cache file")
    s.add_argument("--out", required=True, help="JSON rows, and the .npz next to it")
    s.add_argument("--model", help="score this model file on the gate days instead")
    s.add_argument("--start-up", help="a model file whose start_up_seconds to use")
    s.add_argument("--orders", type=parse_orders, default=list(ORDERS))
    s.add_argument("--spreads", type=parse_floats, default=list(SPREADS))
    s.add_argument("--bases", type=parse_floats, default=list(BASES))
    s.set_defaults(func=sweep)
