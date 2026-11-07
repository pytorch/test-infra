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
from torchci.td.analysis import breakdowns, config
from torchci.td.analysis.labels import unix
from torchci.td.analysis.landed import gold_events, silver_events, Views
from torchci.td.analysis.schema import load, RESULTS_FILE, step_dir, write_atomic, write_manifest
from torchci.td.analysis.selection import paired, POLICIES, recall, strip, TIME_TARGETS, Unit, unit_seconds


logger = logging.getLogger(__name__)

PAIRS = [("before@25", p) for p in ("after@25", "adaptive@20", "cheap_time@td25", "adaptive_time@td25", "adaptive_time@td20")] + [
    ("cheap_time@td25", "adaptive_time@td25")]


def run(cache: Path) -> None:
    units_df, gold, silver = load(cache, "labels", "units"), load(cache, "labels", "gold"), load(cache, "labels", "silver")
    rows = load(cache, "features", "rows")
    preds, risk = load(cache, "train", "preds"), load(cache, "train", "risk")
    preds = preds[preds["week"] >= unix(str(config.EVAL_START))]
    ev = units_df[units_df["unit_id"].isin(set(preds["unit_id"]))].set_index("unit_id")
    rows = rows[rows["unit_id"].isin(ev.index)].merge(preds[["unit_id", "test", "p"]], on=["unit_id", "test"], how="left")
    units: dict[str, Unit] = {}
    for uid, g in rows.groupby("unit_id"):
        tests = list(ev.loc[uid, "candidates"])
        units[uid] = Unit(uid, tests, dict(zip(g["test"], g["before_score"])), dict(zip(g["test"], g["p"].fillna(0.0))),
                          unit_seconds(tests, dict(zip(g["test"], g["test_seconds"]))))
    main_ids = sorted(u for u in units if ev.loc[u, "kind"] == "main" and ev.loc[u, "single"])
    time_targets = {name: float(np.mean([units[u].share(f"before@{k}")[1] for u in main_ids])) for name, k in TIME_TARGETS.items()}
    budgets = risk.set_index("unit_id")[[f"budget_{t}" for t in config.BUDGET_TARGETS]].to_dict("index")
    for uid, u in units.items():
        b = budgets.get(uid, {})
        u.add_adaptive({t: int(b.get(f"budget_{t}", t)) for t in config.BUDGET_TARGETS}, time_targets)
    views = Views(load(cache, "rankings", "main_ranks"), units, budgets, time_targets)
    results = build_results(units, views, ev, gold, silver, rows, risk, units_df, main_ids)
    logger.info("units evaluated: %d, config views of landed changes: %d", len(units), len(views.built))
    results["time_targets"] = time_targets
    results["importance"] = load(cache, "train", "importance").to_dict("records")
    path = step_dir(cache, "evaluate") / RESULTS_FILE
    write_atomic(path, json.dumps(results, indent=1, default=float))
    write_manifest(cache, "evaluate", {}, results=path.name)


def build_results(units, views, ev, gold, silver, rows, risk, units_df, main_ids) -> dict[str, Any]:
    g_events, g_outcomes, g_dropped, fg_window = gold_events(views, ev, gold)
    silver_pos = {u: list(ev.loc[u, "positives"]) for u in main_ids if len(ev.loc[u, "positives"])}
    s_events, silver_view = silver_events(views, ev, silver_pos)
    off_pos = {u: list(ev.loc[u, "positives"]) for u in units if ev.loc[u, "kind"] == "pr_off" and len(ev.loc[u, "positives"])}
    combined = {**units, **views.built}
    pops = {"gold": g_events, "silver": s_events, "pr_off": [([u], {u: f}) for u, f in off_pos.items()]}
    rec = {name: recall(combined, evs) for name, evs in pops.items()}
    on_ids = [u for u in units if ev.loc[u, "kind"] == "pr_on"]
    out: dict[str, Any] = {"recall": {k: strip(v) for k, v in rec.items()}}
    out["paired"] = {name: [paired(r, a, b) for a, b in PAIRS] for name, r in rec.items()}
    out["pr_bootstrap"] = breakdowns.pr_bootstrap(rec["pr_off"], [int(ev.loc[u, "pr_number"]) for u in off_pos], PAIRS)
    out["silver_by_share"] = breakdowns.silver_by_share(combined, silver, silver_view, ev)
    out["pr_off_by_recurrence"] = breakdowns.pr_recurrence(units, ev, units_df, off_pos)
    out["overhead_sensitivity"] = breakdowns.overhead_sensitivity(units, main_ids, off_pos)
    out["precision"] = {}
    for p in POLICIES:
        selected = sum(len(units[u].sel[p]) for u in main_ids)
        hours = sum(units[u].seconds[t] for u in main_ids for t in units[u].sel[p]) / 3600
        caught = sum(len(set(f) & units[u].sel[p]) for u, f in silver_pos.items())
        out["precision"][p] = {"caught": caught, "selected": selected, "precision": caught / selected if selected else None,
                               "tests_per_catch": selected / caught if caught else None, "test_hours": hours,
                               "per_1000_hours": 1000 * caught / hours if hours else None}
    out["reds"] = breakdowns.reds(rec["gold"], rec["pr_off"], g_outcomes, gold, units, ev, on_ids, fg_window)
    pr_ids = sorted(off_pos)
    out["cost"] = {pop: {p: dict(zip(("test_share", "time_share"), np.mean([units[u].share(p) for u in ids], axis=0).tolist())) for p in POLICIES}
                   for pop, ids in (("main", main_ids), ("pr_off", pr_ids))}
    out["calibration"] = {"main": breakdowns.calibration(rows[rows["unit_id"].isin(main_ids)]), "pr_off": breakdowns.calibration(rows[rows["unit_id"].isin(pr_ids)])}
    out["risk"] = breakdowns.risk_summary(risk[risk["unit_id"].isin(units)], units_df)
    out["fidelity"] = breakdowns.fidelity(rows, ev)
    out["meta"] = {"units": {k: int(v) for k, v in ev.loc[list(units), "kind"].value_counts().items()},
                   "pr_off_prs": len({int(ev.loc[u, "pr_number"]) for u in off_pos}), "gold_without_config_lists": g_dropped,
                   "silver_with_config_lists": len(s_events), "silver_units": len(silver_pos), "gold_events": len(g_events),
                   "eval_start": str(config.EVAL_START.date()), "file_overhead_seconds": config.FILE_OVERHEAD_SECONDS,
                   "window": [str(config.WINDOW_START.date()), str((config.WINDOW_STOP - timedelta(days=1)).date())]}
    out["sanity"] = breakdowns.sanity(out)
    return out
