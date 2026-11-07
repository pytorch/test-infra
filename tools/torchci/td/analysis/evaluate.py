"""Evaluate step: Before vs After per cutoff and population, reds kept off main, cost,
calibration, the risk model and the sanity checks; written as results.json.

Populations (evaluation weeks only, every After score out of time):
- gold: reverted trunk breakages TD could have caught (false_green, signal_on_pr,
  passed_on_pr), caught when a breaking file is in the selection of one of the configs
  that failed (landed.py);
- silver: landed changes that newly broke a test on main, the same way;
- pr_off: PR configs whose failure showed on a TD-off job, where every test could run.
The policies are in selection.py.
"""

import json
import logging
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
from torchci.td.analysis import breakdowns, config, model_checks
from torchci.td.analysis.labels import unix
from torchci.td.analysis.landed import gold_events, Views
from torchci.td.analysis.schema import (
    load,
    RESULTS_FILE,
    step_dir,
    write_atomic,
    write_manifest,
)
from torchci.td.analysis.selection import (
    paired,
    POLICIES,
    recall,
    strip,
    TIME_TARGETS,
    Unit,
    unit_seconds,
)


logger = logging.getLogger(__name__)

DAY = 86400

PAIRS = [("before@25", p) for p in ("adaptive_time@td25", "adaptive_time@td20")]


def run(cache: Path) -> None:
    units_df, gold, silver = (
        load(cache, "labels", "units"),
        load(cache, "labels", "gold"),
        load(cache, "labels", "silver"),
    )
    rows = load(cache, "features", "rows")
    preds, risk = load(cache, "train", "preds"), load(cache, "train", "risk")
    kind = preds["unit_id"].map(units_df.set_index("unit_id")["kind"])
    first_week = np.where(
        kind == "main",
        unix(str(config.SILVER_EVAL_START)),
        unix(str(config.EVAL_START)),
    )
    preds = preds[preds["week"] >= first_week]
    ev = units_df[units_df["unit_id"].isin(set(preds["unit_id"]))].set_index("unit_id")
    rows = rows[rows["unit_id"].isin(ev.index)].merge(
        preds[["unit_id", "test", "p"]], on=["unit_id", "test"], how="left"
    )
    units: dict[str, Unit] = {}
    for uid, g in rows.groupby("unit_id"):
        tests = list(ev.loc[uid, "candidates"])
        units[uid] = Unit(
            uid,
            tests,
            dict(zip(g["test"], g["before_score"])),
            dict(zip(g["test"], g["p"].fillna(0.0))),
            unit_seconds(tests, dict(zip(g["test"], g["test_seconds"]))),
        )
    silver_ids = sorted(
        u for u in units if ev.loc[u, "kind"] == "main" and ev.loc[u, "single"]
    )
    main_ids = [
        u for u in silver_ids if ev.loc[u, "time"] >= unix(str(config.EVAL_START))
    ]
    scales = time_scales(risk, ev, units)
    for uid, u in units.items():
        u.add_adaptive(scales[uid])
    views = Views(load(cache, "rankings", "main_ranks"), units)
    results = build_results(
        units, views, ev, gold, silver, rows, risk, units_df, main_ids, silver_ids
    )
    logger.info(
        "units evaluated: %d, config views of landed changes: %d",
        len(units),
        len(views.built),
    )
    results["time_targets"] = {
        name: float(np.mean([units[u].share(f"before@{k}")[1] for u in main_ids]))
        for name, k in TIME_TARGETS.items()
    }
    results["importance"] = load(cache, "train", "importance").to_dict("records")
    path = step_dir(cache, "evaluate") / RESULTS_FILE
    write_atomic(path, json.dumps(results, indent=1, default=float))
    write_manifest(cache, "evaluate", {}, results=path.name)


def time_scales(risk, ev, units) -> dict[str, float]:
    """Each unit's multiplier on its test-time budget: the risk model's cutoff for the
    first target mean over the mean cutoff of the unit's population (landed changes, PR
    jobs) in its week, so each population's multipliers average 1 every week and After
    spends TD's test time on average. The model is fit on landed changes, and PR jobs,
    which lack line counts, would otherwise all sit higher; its scores drift between
    months, which a weekly mean absorbs. Label-free: only the cutoffs' means are used."""
    ids = list(units)
    r = risk.set_index("unit_id").reindex(ids)
    kind = ev.loc[ids, "kind"].replace({"pr_on": "pr", "pr_off": "pr"})
    week = ev.loc[ids, "time"] // (7 * DAY)
    t = config.BUDGET_TARGETS[0]
    col = r[f"budget_{t}"].fillna(t)
    mean = col.groupby([kind.to_numpy(), week.to_numpy()]).transform("mean")
    return dict(zip(ids, (col / mean).to_numpy()))


def build_results(
    units, views, ev, gold, silver, rows, risk, units_df, main_ids, silver_ids
) -> dict[str, Any]:
    """main_ids: the landed changes of the evaluation weeks the PR and gold populations
    use; silver_ids: those of the longer window of new failures on main, cut over each
    change's full test list (TD's per-config lists are only logged from August 2026)."""
    g_events, g_outcomes, g_dropped, fg_window = gold_events(views, ev, gold)
    silver_pos = {
        u: list(ev.loc[u, "positives"])
        for u in silver_ids
        if len(ev.loc[u, "positives"])
    }
    silver_view = {u: ([u], {u: f}) for u, f in silver_pos.items()}
    s_events = list(silver_view.values())
    # New failures of tests that already failed on main in the 14 days before are mostly
    # flaky re-failures, which dominate some months; the fresh ones are likelier
    # regressions.
    fresh = set(
        silver.loc[silver["fail_share"] == 0, ["sha", "file"]].itertuples(index=False)
    )
    fresh_pos = {
        u: kept
        for u, fs in silver_pos.items()
        if (kept := [f for f in fs if (ev.loc[u, "sha"], f) in fresh])
    }
    main_pos = {u: silver_pos[u] for u in main_ids if u in silver_pos}
    off_pos = {
        u: list(ev.loc[u, "positives"])
        for u in units
        if ev.loc[u, "kind"] == "pr_off" and len(ev.loc[u, "positives"])
    }
    combined = {**units, **views.built}
    pops = {
        "gold": g_events,
        "silver": s_events,
        "silver_fresh": [([u], {u: f}) for u, f in fresh_pos.items()],
        "pr_off": [([u], {u: f}) for u, f in off_pos.items()],
    }
    rec = {name: recall(combined, evs) for name, evs in pops.items()}
    on_ids = [u for u in units if ev.loc[u, "kind"] == "pr_on"]
    out: dict[str, Any] = {"recall": {k: strip(v) for k, v in rec.items()}}
    out["paired"] = {
        name: [paired(r, a, b) for a, b in PAIRS] for name, r in rec.items()
    }
    out["pr_bootstrap"] = breakdowns.pr_bootstrap(
        rec["pr_off"], [int(ev.loc[u, "pr_number"]) for u in off_pos], PAIRS
    )
    out["silver_by_share"] = breakdowns.silver_by_share(
        combined, silver, silver_view, ev
    )
    out["pr_off_by_recurrence"] = breakdowns.pr_recurrence(units, ev, units_df, off_pos)
    out["overhead_sensitivity"] = breakdowns.overhead_sensitivity(
        units, main_ids, off_pos
    )
    out["precision"] = {}
    for p in POLICIES:
        selected = sum(len(units[u].sel[p]) for u in main_ids)
        hours = (
            sum(units[u].seconds[t] for u in main_ids for t in units[u].sel[p]) / 3600
        )
        caught = sum(len(set(f) & units[u].sel[p]) for u, f in main_pos.items())
        out["precision"][p] = {
            "caught": caught,
            "selected": selected,
            "precision": caught / selected if selected else None,
            "tests_per_catch": selected / caught if caught else None,
            "test_hours": hours,
            "per_1000_hours": 1000 * caught / hours if hours else None,
        }
    out["reds"] = breakdowns.reds(
        rec["gold"], rec["pr_off"], g_outcomes, gold, units, ev, on_ids, fg_window
    )
    pr_ids = sorted(off_pos)
    out["cost"] = {
        pop: {
            p: dict(
                zip(
                    ("test_share", "time_share"),
                    np.mean([units[u].share(p) for u in ids], axis=0).tolist(),
                )
            )
            for p in POLICIES
        }
        for pop, ids in (("main", main_ids), ("pr_off", pr_ids))
    }
    out["calibration"] = {
        "main": model_checks.calibration(rows[rows["unit_id"].isin(main_ids)]),
        "pr_off": model_checks.calibration(rows[rows["unit_id"].isin(pr_ids)]),
    }
    out["risk"] = model_checks.risk_summary(risk[risk["unit_id"].isin(units)], units_df)
    out["fidelity"] = model_checks.fidelity(rows, ev)
    out["rebuild_check"] = model_checks.rebuild_check(rows, ev, silver_pos)
    out["meta"] = {
        "units": {
            k: int(v) for k, v in ev.loc[list(units), "kind"].value_counts().items()
        },
        "pr_off_prs": len({int(ev.loc[u, "pr_number"]) for u in off_pos}),
        "gold_without_config_lists": g_dropped,
        "silver_units": len(silver_pos),
        "silver_eval_start": str(config.SILVER_EVAL_START.date()),
        "gold_events": len(g_events),
        "eval_start": str(config.EVAL_START.date()),
        "file_overhead_seconds": config.FILE_OVERHEAD_SECONDS,
        "window": [
            str(config.MAIN_START.date()),
            str((config.WINDOW_STOP - timedelta(days=1)).date()),
        ],
    }
    out["sanity"] = breakdowns.sanity(out)
    return out
