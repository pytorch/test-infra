"""The scorer's rows: one per (unit, candidate test file) of torchci.td.labels' main and
pr_td_off units, with the label, the training weight, the cost and every feature of
spec.ROW_COLUMNS; plus one row per unit with its weight and risk inputs
(spec.UNIT_COLUMNS).

Every input of a row predates its unit's cutoff (context.py): the failure ratings are
rebuilt for the cutoff's day from the history before it, without the head's own
failures. fail_n and prev_failed are NaN where the fetched history or PR failures
start less than history.COVERAGE_DAYS before (a source that does not reach back is not
a 0). Test times, co-edits and profiling are today's files, as the TD job reads
them. The served heuristics are normalised over the unit month's whole test list, as
the TD job normalises over all of TESTS, then kept for the unit's candidates.

Training rows subsample: main units with no positive are kept with probability
UNIT_KEEP and negatives with NEG_KEEP, each by a stable hash and weighted by the
inverse. Units from `full_from` on keep every candidate with weight 1 (`full`), and
only their rows carry co-edit and profiling, for replaying TD's sum."""

import hashlib
import json
import logging
import math
import multiprocessing as mp
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Optional

import numpy as np
import pandas as pd
from torchci.td.labels.schema import DAY, epoch, MAIN, month_of, PR_TD_OFF, sql_time
from torchci.td.llm.replay import FileTimes
from torchci.td.scorer import context, heuristics, history, pathrisk, spec
from torchci.td.scorer.context import Context
from torchci.td.scorer.heuristics import Helpers


logger = logging.getLogger(__name__)

UNIT_KEEP = 0.2
NEG_KEEP = 0.2
# pytorch's exploration.estimate_costs adds this to every test's seconds.
COST_OVERHEAD_SECONDS = 15.0
PROCS = 6
STATS_FILES = (
    "test-times",
    "td_heuristic_historical_edited_files",
    "td_heuristic_profiling",
)
TIMES, COEDIT, PROFILING = STATS_FILES
FEATURES = (*spec.SCORER_FEATURES, *spec.TD_ONLY)

# Shared with forked workers.
CTX: dict[str, Any] = {}


def load_stats(stats_dir: Path) -> dict[str, Any]:
    """The generated-stats files the rows read, by STATS_FILES name."""
    return {
        name: json.loads((stats_dir / f"{name}.json").read_text())
        for name in STATS_FILES
    }


def keep(key: str, p: float) -> bool:
    """A stable draw with probability p (the same on every run and host)."""
    digest = hashlib.blake2b(key.encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") / 2**64 < p


def day_of(ts: int) -> int:
    return ts - ts % DAY


def candidates(u: dict[str, Any], months: Mapping[str, list[str]]) -> list[str]:
    """A main unit's month list, a PR unit's own list (the job's tests)."""
    if u["kind"] == MAIN:
        return list(months[u["candidates_month"]])
    return list(u["candidates"])


def labels(u: dict[str, Any], tests: list[str]) -> np.ndarray:
    """1 for positives; 0 for every other main candidate and for a PR unit's observed
    files; NaN (unlabelled) otherwise."""
    pos = set(u["positives"])
    if u["kind"] == MAIN:
        return np.array([1.0 if t in pos else 0.0 for t in tests])
    observed = set(u["observed"] or ())
    return np.array(
        [1.0 if t in pos else 0.0 if t in observed else math.nan for t in tests]
    )


def job_times(
    u: dict[str, Any], test_times: Mapping[str, Any], times: FileTimes
) -> Mapping[str, float]:
    """The file seconds the unit's job reads, as run_test.py's load_test_times_from_file
    picks them: its environment's config, else the default job's config, else the
    default job's default config. A main unit has no job: the median over every entry."""
    if u["kind"] == MAIN:
        return times.fallback
    config, default = u["test_config"], test_times.get("default", {})
    if config in test_times.get(u["build_environment"], {}):
        return test_times[u["build_environment"]][config]
    return default[config] if config in default else default.get("default", {})


def costs(
    u: dict[str, Any], tests: list[str], test_times: Mapping[str, Any], times: FileTimes
) -> np.ndarray:
    """pytorch's exploration.estimate_costs on the unit's job: each test's recorded
    seconds (0 counts), else the median of the recorded ones, plus
    COST_OVERHEAD_SECONDS; NaN for every test when none is recorded (TD's cut then)."""
    file_times = job_times(u, test_times, times)
    durations = [file_times.get(t) for t in tests]
    known = [max(0.0, float(d)) for d in durations if d is not None]
    if not known:
        return np.full(len(tests), math.nan)
    fill = statistics.median(known)
    return np.array(
        [
            (fill if d is None else max(0.0, float(d))) + COST_OVERHEAD_SECONDS
            for d in durations
        ]
    )


def selected_units(
    units: list[dict[str, Any]], full_from: datetime
) -> list[dict[str, Any]]:
    """The units that produce rows, the single source of that choice: main and
    pr_td_off units with train_ok, PR units only with observed files (their negatives),
    main units with no positive only when the stable hash of their id keeps them
    (UNIT_KEEP), and every such unit from `full_from` (naive UTC) on. The CLI calls it
    before scoring the LLM, so only these units' diffs are embedded; build() uses it."""
    t0 = epoch(full_from)
    out = []
    for u in units:
        if u["kind"] not in context.KINDS or not u["train_ok"]:
            continue
        if u["kind"] == PR_TD_OFF and u["observed"] is None:
            continue
        if unit_weight(u, t0) > 1 and not keep(u["unit_id"], UNIT_KEEP):
            continue
        out.append(u)
    return out


def unit_weight(u: dict[str, Any], full_from: int) -> float:
    """The weight selected_units' subsampling gives a unit: 1 / UNIT_KEEP for a main
    unit without a positive before `full_from` (unix seconds), else 1."""
    sampled = u["kind"] == MAIN and not u["positives"] and int(u["time"]) < full_from
    return 1 / UNIT_KEEP if sampled else 1.0


def weights(
    u: dict[str, Any], tests: list[str], y: np.ndarray, full_from: int
) -> np.ndarray:
    """Each candidate's training weight, 0 where the row is not kept: the unit's
    unit_weight, a kept negative 1 / NEG_KEEP more; 1 for every candidate of a unit
    from `full_from` (unix seconds) on."""
    if int(u["time"]) >= full_from:
        return np.ones(len(tests))
    unit_w = unit_weight(u, full_from)
    w = np.where(np.isnan(y), 0.0, unit_w)
    for i, t in enumerate(tests):
        if y[i] == 0:
            w[i] = unit_w / NEG_KEEP if keep(f"{u['unit_id']}\0{t}", NEG_KEEP) else 0.0
    return w


def served(
    c: dict[str, Any],
    month_tests: list[str],
    ratings: heuristics.Ratings,
    h: Helpers,
) -> dict[str, dict[str, float]]:
    """Per served heuristic, its score per test over the unit month's whole list."""
    changed, tests = c["changed"], month_tests
    return {
        "prev_failed": dict.fromkeys(set(c["prev_failed"]) & set(tests), 1.0),
        "edited": dict.fromkeys(heuristics.edited(h, changed, tests), 1.0),
        "mentioned": dict.fromkeys(set(c["mentioned"]) & set(tests), 1.0),
        "fail_n": heuristics.rating_served(ratings, changed, tests),
        "filepath_s": heuristics.filepath_served(h, changed, tests),
        "public_bindings": dict.fromkeys(
            heuristics.public_bindings(changed, tests), 1.0
        ),
    }


def unit_rows(u: dict[str, Any], ratings: heuristics.Ratings) -> Optional[pd.DataFrame]:
    """The unit's kept rows, or None when it keeps none."""
    c, h, months = CTX["ctx"].units[u["unit_id"]], CTX["helpers"], CTX["months"]
    full = u["time"] >= CTX["full_from"]
    tests = candidates(u, months)
    y = labels(u, tests)
    w = weights(u, tests, y, CTX["full_from"])
    kept = np.flatnonzero(w > 0)
    if not len(kept):
        return None
    names = [tests[i] for i in kept]
    fresh = set(c["fresh"])
    month_tests = context.unit_tests(u, months)
    scores = served(c, month_tests, ratings, h)
    llm = CTX["llm"].get(u["unit_id"], {}) if CTX["llm"] is not None else {}
    scores["llm_n"] = llm
    if full:
        stats = CTX["stats"]
        for name, key in zip(spec.TD_ONLY, (COEDIT, PROFILING)):
            scores[name] = heuristics.rating_served(
                stats[key], c["changed"], month_tests
            )
    times = CTX["times"]
    df = pd.DataFrame(
        {
            "unit_id": u["unit_id"],
            "kind": u["kind"],
            "time": np.int64(u["time"]),
            "test": names,
            "y": y[kept],
            "w": w[kept],
            "fresh": [t in fresh for t in names],
            "full": full,
            "cost": costs(u, tests, CTX["stats"][TIMES], times)[kept],
        }
    )
    for name, per_test in scores.items():
        df[name] = [float(per_test.get(t, 0.0)) for t in names]
    if not full:
        for name in spec.TD_ONLY:
            df[name] = math.nan
    df["test_seconds"] = [float(times.fallback.get(t, 0.0)) for t in names]
    df["is_pr"] = float(u["kind"] == PR_TD_OFF)
    ctx: Context = CTX["ctx"]
    if not history.covered(ctx.history_start, day_of(c["cutoff"])):
        df["fail_n"] = math.nan
    if not history.covered(ctx.pr_failures_start, c["cutoff"]):
        df["prev_failed"] = math.nan
    for name, value in c["stats"].items():
        df[name] = value
    return df[list(spec.ROW_COLUMNS)].astype({f: np.float64 for f in FEATURES})


def run_day(day: int) -> list[pd.DataFrame]:
    """The rows of the units whose cutoff falls on `day`."""
    ctx: Context = CTX["ctx"]
    ratings = heuristics.rebuild_fail(ctx.history, ctx.merge_bases, day)
    heads = CTX["history_heads"]
    out = []
    for u in CTX["by_day"][day]:
        own = heads.get(u["sha"], ())
        if u["kind"] == PR_TD_OFF and any(
            day - history.HISTORY_DAYS * DAY <= ts < day for ts in own
        ):
            r = heuristics.rebuild_fail(ctx.history, ctx.merge_bases, day, u["sha"])
        else:
            r = ratings
        df = unit_rows(u, r)
        if df is not None:
            out.append(df)
    logger.info("day %s: %d units", sql_time(day)[:10], len(out))
    return out


def unit_table(
    units: list[dict[str, Any]],
    ctx: Context,
    full_from: int,
    history: Optional[pathrisk.History] = None,
) -> pd.DataFrame:
    """One row per unit: its weight and risk inputs; spec.PATH_FEATURES from `history`
    (pathrisk.unit_values), NaN without one."""
    cs = [ctx.units[u["unit_id"]] for u in units]
    paths = (
        pathrisk.unit_values(history, [(c["cutoff"], c["changed"]) for c in cs])
        if history is not None
        else [dict.fromkeys(spec.PATH_FEATURES, math.nan)] * len(cs)
    )
    rows = [
        {
            "unit_id": u["unit_id"],
            "kind": u["kind"],
            "time": int(u["time"]),
            "train_ok": bool(u["train_ok"]),
            "n_positives": len(u["positives"]),
            "uw": unit_weight(u, full_from),
            **heuristics.risk_inputs(c["stats"], c["sig_added"], c["sig_deleted"]),
            **path,
        }
        for u, c, path in zip(units, cs, paths)
    ]
    df = pd.DataFrame(rows, columns=list(spec.UNIT_COLUMNS))
    return df.astype(
        {"time": np.int64, "train_ok": bool, "n_positives": np.int64, "uw": np.float64}
    )


def rows_for(
    units: list[dict[str, Any]],
    months: Mapping[str, list[str]],
    ctx: Context,
    h: Helpers,
    stats: Mapping[str, Any],
    full_from: datetime,
    llm: Optional[Mapping[str, Mapping[str, float]]] = None,
    procs: int = PROCS,
    history: Optional[pathrisk.History] = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The rows and the unit table (unit_table) of the selected units (selected_units)
    that have context and a month list."""
    dropped: Counter = Counter(ctx.dropped)
    have = []
    for u in units:
        if u["unit_id"] not in ctx.units:
            continue
        if month_of(int(u["time"])) not in months:
            dropped[f"{u['kind']}:no_month_list"] += 1
            continue
        ctx.units[u["unit_id"]]["stats"] = heuristics.unit_stats(
            h, ctx.units[u["unit_id"]]["changed"]
        )
        have.append(u)
    table = unit_table(have, ctx, epoch(full_from), history)
    by_day: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for u in have:
        by_day[day_of(ctx.units[u["unit_id"]]["cutoff"])].append(u)
    heads: dict[str, list[int]] = defaultdict(list)
    for r in ctx.history:
        heads[r["head_sha"]].append(r["ts"])
    CTX.update(
        ctx=ctx,
        helpers=h,
        months=months,
        stats=stats,
        times=FileTimes(stats[TIMES]),
        llm=llm,
        full_from=epoch(full_from),
        by_day=by_day,
        history_heads=heads,
    )
    days = sorted(by_day)
    if procs > 1 and len(days) > 1:
        with mp.get_context("fork").Pool(min(procs, len(days))) as pool:
            parts = [df for dfs in pool.imap_unordered(run_day, days) for df in dfs]
    else:
        parts = [df for d in days for df in run_day(d)]
    CTX.clear()
    rows = (
        pd.concat(parts, ignore_index=True)
        if parts
        else pd.DataFrame(columns=list(spec.ROW_COLUMNS))
    )
    rows = rows.sort_values(["time", "unit_id", "test"], ignore_index=True)
    table.attrs["dropped"] = dict(sorted(dropped.items()))
    logger.info(
        "rows: %d of %d units; dropped %s", len(rows), len(table), dict(dropped)
    )
    return rows, table


def build(
    units_dir: Path,
    repo: Path,
    stats: Mapping[str, Any],
    start: datetime,
    stop: datetime,
    full_from: datetime,
    llm: Optional[Mapping[str, Mapping[str, float]]] = None,
    procs: int = PROCS,
    history: Optional[pathrisk.History] = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The rows (spec.ROW_COLUMNS) and the unit table (spec.UNIT_COLUMNS) of the
    selected units (selected_units) of `units_dir` (a torchci.td.labels output) in
    [start, stop), naive UTC datetimes. With an `llm` mapping (unit id -> {test: llm_n},
    sparse), a unit it lacks is dropped: its diff could not be read, and TD always has
    the LLM score. Without one, llm_n is 0.0 everywhere. The unit table's path risk
    comes from `history` (main's history, pathrisk.History)."""
    units, months = context.read_labels(units_dir)
    units = selected_units(context.window_units(units, start, stop), full_from)
    llm_dropped: Counter = Counter()
    if llm is not None:
        llm_dropped.update(
            f"{u['kind']}:no_llm" for u in units if u["unit_id"] not in llm
        )
        units = [u for u in units if u["unit_id"] in llm]
    h = heuristics.load_helpers(repo, units_dir / "cache")
    ctx = context.build(units, months, repo, start, stop)
    ctx.dropped.update(llm_dropped)
    return rows_for(units, months, ctx, h, stats, full_from, llm, procs, history)
