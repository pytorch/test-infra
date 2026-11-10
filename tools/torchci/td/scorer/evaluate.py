"""The gate's replay: TD's 25% count cut and the model's matched cut (the cut step
pytorch's run_test.py takes) per unit, recall over failure events, the paired
bootstrap and calibration; `run_gate` puts them together for the refit."""

import math
from typing import Any, Callable, cast, Mapping, Optional, Sequence

import numpy as np
import pandas as pd
from torchci.greenlight_replay.compare_stats import wilson
from torchci.td.labels.schema import DAY, epoch, MAIN, PR_TD_OFF
from torchci.td.llm.replay import cut_position
from torchci.td.scorer import gate, spec, train


EXPONENTS = tuple(i / 20 for i in range(21))
MAX_GAP = 0.25
BOOTSTRAP = 1000
CONFIDENCE = 0.95
CALIBRATION_DAYS = 56
MIN_CALIBRATION_POSITIVES = 20
RELIABILITY_BINS = 10
# Event kinds: a PR-specific failure on a TD-off PR job, and a fresh failure on main.
EVENT_KINDS = {PR_TD_OFF: "pr", MAIN: "main"}
CUTS = ("td", "model")


def cut_count(n: int) -> int:
    """How many of `n` tests TD's cut keeps (`get_top_per_tests`), at most all of them."""
    return min(n, cut_position(n) + 1)


def matched_cut(
    tests_in_td_order: Sequence[str],
    p: Mapping[str, float],
    cost: Mapping[str, float],
) -> tuple[Optional[float], list[str]]:
    """(the exponent a, the tests kept) of the order p / cost ** a whose cut costs closest
    to TD's own cut (ties: the smaller a); (None, TD's cut) when even that one is more than
    MAX_GAP of TD's cost away, or when a cost is unknown (NaN), as pytorch falls back
    without test times."""
    tests = list(tests_in_td_order)
    if not tests:
        return None, []
    n = cut_count(len(tests))
    if any(math.isnan(cost[t]) for t in tests):
        return None, tests[:n]
    target = sum(cost[t] for t in tests[:n])
    best: Optional[tuple[float, float, list[str]]] = None
    for a in EXPONENTS:
        key = {t: p[t] / cost[t] ** a for t in tests}
        order = sorted(tests, key=lambda t: (-key[t], str(t)))
        gap = abs(sum(cost[t] for t in order[:n]) - target)
        if best is None or gap < best[0]:
            best = (gap, a, order)
    if best is None or best[0] > MAX_GAP * target:
        return None, tests[:n]
    return best[1], best[2][:n]


def mean(values: Sequence[float]) -> Optional[float]:
    """The mean of the known (non-NaN) values, None without any."""
    known = [v for v in values if not math.isnan(v)]
    return sum(known) / len(known) if known else None


def td_order(unit_rows: pd.DataFrame) -> list[str]:
    """The unit's tests in TD's order: its heuristic sum as served, desc, then name."""
    score = unit_rows[list(spec.TD_SUM_PARTS)].fillna(0.0).sum(axis=1).to_numpy()
    tests = unit_rows["test"].tolist()
    return [t for _, t in sorted(zip(-score, tests))]


def rate(caught: int, n: int) -> dict[str, Any]:
    lo, hi = wilson(caught / n, n) if n else (0.0, 0.0)
    return {
        "caught": caught,
        "n": n,
        "rate": caught / n if n else None,
        "lo": lo,
        "hi": hi,
    }


def evaluate(
    predict_fn: Callable[[pd.DataFrame], np.ndarray], full_rows: pd.DataFrame
) -> dict[str, Any]:
    """Per unit of `full_rows` (every candidate of the unit): p from `predict_fn`, TD's
    cut and the matched cut with the rows' `cost`. Events: each (TD-off PR unit, positive
    file) and each (main unit, fresh positive file); an event is caught by a cut that keeps
    its file. Recall per kind and pooled with Wilson intervals, the cuts' mean shares of
    tests and cost per kind, and the per-event hits for the paired bootstrap."""
    rows = full_rows[full_rows["kind"].isin(list(EVENT_KINDS))]
    p_all = predict_fn(rows) if len(rows) else np.zeros(0)
    events: dict[str, list[Any]] = {"unit": [], "kind": [], "td": [], "model": []}
    shares: dict[str, list[tuple[float, float, float]]] = {
        k: [] for k in EVENT_KINDS.values()
    }
    exponents: dict[str, int] = {}
    no_costs = 0
    groups = rows.groupby(["unit_id", "kind"], sort=True).indices
    for key, idx in groups.items():
        uid, kind = (str(k) for k in cast(tuple, key))
        unit = rows.iloc[idx]
        p = dict(zip(unit["test"], p_all[idx]))
        cost = dict(zip(unit["test"], unit["cost"].astype(float)))
        order = td_order(unit)
        a, model_cut = matched_cut(order, p, cost)
        no_costs += any(math.isnan(c) for c in cost.values())
        exponents[str(a)] = exponents.get(str(a), 0) + 1
        td_cut = order[: len(model_cut)]
        total = sum(cost.values())
        k = EVENT_KINDS[kind]
        shares[k].append(
            (
                len(td_cut) / len(order),
                sum(cost[t] for t in td_cut) / total,
                sum(cost[t] for t in model_cut) / total,
            )
        )
        failed = unit["y"] == 1
        if kind == MAIN:
            failed &= unit["fresh"].astype(bool)
        td_set, model_set = set(td_cut), set(model_cut)
        for test in sorted(unit.loc[failed, "test"]):
            events["unit"].append(uid)
            events["kind"].append(k)
            events["td"].append(test in td_set)
            events["model"].append(test in model_set)
    out: dict[str, Any] = {
        "units": sum(map(len, shares.values())),
        "exponents": exponents,
        "td_cut_no_costs": no_costs,
    }
    for k in (*EVENT_KINDS.values(), "pooled"):
        pick = [i for i, e in enumerate(events["kind"]) if k in ("pooled", e)]
        s = [x for kk, v in shares.items() if k in ("pooled", kk) for x in v]
        out[k] = {
            "units": len(s),
            "test_share": mean([x[0] for x in s]),
            **{
                cut: {
                    **rate(sum(events[cut][i] for i in pick), len(pick)),
                    "cost_share": mean([x[1 + j] for x in s]),
                }
                for j, cut in enumerate(CUTS)
            },
        }
    out["events"] = events
    return out


def paired_bootstrap(
    hits_a: Sequence[bool],
    hits_b: Sequence[bool],
    units: Sequence[str],
    n: int = BOOTSTRAP,
    seed: int = 0,
) -> Optional[dict[str, Any]]:
    """Pooled recall of a minus b with a CONFIDENCE interval, resampling units (an
    event's unit is `units[i]`); None without events."""
    if not len(units):
        return None
    _, inverse = np.unique(np.asarray(units), return_inverse=True)
    a = np.bincount(inverse, weights=np.asarray(hits_a, dtype=float))
    b = np.bincount(inverse, weights=np.asarray(hits_b, dtype=float))
    count = np.bincount(inverse).astype(float)
    picks = np.random.default_rng(seed).integers(0, len(count), (n, len(count)))
    diffs = (a[picks].sum(axis=1) - b[picks].sum(axis=1)) / count[picks].sum(axis=1)
    tail = (1 - CONFIDENCE) / 2
    return {
        "diff": float((a.sum() - b.sum()) / count.sum()),
        "lo": float(np.quantile(diffs, tail)),
        "hi": float(np.quantile(diffs, 1 - tail)),
        "events": int(count.sum()),
        "units": len(count),
    }


def calibration(p: np.ndarray, y: np.ndarray) -> Optional[dict[str, Any]]:
    """mean(p) / mean(y), Brier, the base rate and a reliability table of
    RELIABILITY_BINS equal-count bins by p; None below MIN_CALIBRATION_POSITIVES."""
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)
    if y.sum() < MIN_CALIBRATION_POSITIVES:
        return None
    order = np.argsort(p, kind="stable")
    bins = [
        {"n": len(b), "mean_p": float(p[b].mean()), "observed": float(y[b].mean())}
        for b in np.array_split(order, RELIABILITY_BINS)
        if len(b)
    ]
    return {
        "ratio": float(p.mean() / y.mean()),
        "brier": float(np.mean((p - y) ** 2)),
        "base_rate": float(y.mean()),
        "mean_p": float(p.mean()),
        "rows": len(p),
        "positives": int(y.sum()),
        "reliability": bins,
    }


def calibration_rows(
    rows: pd.DataFrame, units: pd.DataFrame, stop: int
) -> pd.DataFrame:
    """Full rows of landed `train_ok` changes in the CALIBRATION_DAYS before `stop`."""
    ids = train.landed_units(units, stop - CALIBRATION_DAYS * DAY, stop)["unit_id"]
    keep = rows["unit_id"].isin(ids) & rows["full"].astype(bool) & rows["y"].notna()
    return rows[keep]


def predictor(doc: dict[str, Any]) -> Callable[[pd.DataFrame], np.ndarray]:
    """p of a frame's rows under an exported model (the model of record)."""
    return lambda frame: train.predict_matrix(doc, train.matrix(frame, doc["features"]))


def strip(metrics: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in metrics.items() if k != "events"}


def full_slice(rows: pd.DataFrame, start: int, stop: int) -> pd.DataFrame:
    keep = rows["full"].astype(bool) & (rows["time"] >= start) & (rows["time"] < stop)
    return rows[keep]


def run_gate(
    rows: pd.DataFrame,
    units: pd.DataFrame,
    cutoff: int,
    live: Optional[dict[str, Any]],
    trained_at: str,
    source: dict[str, Any],
) -> dict[str, Any]:
    """A twin of the model, trained before the last GATE_DAYS before `cutoff`, against TD
    on those days and against the live model on the units after both models' data. On the
    last CALIBRATION_DAYS: the calibration of a second twin trained before them (out of
    sample), fit only when they hold enough positives, and the live model's drift. As
    information only, the twin's calibration on the TD-off PR units of the last GATE_DAYS:
    those exist only when the job had a PR-specific failure, so their ratio is not
    comparable to 1."""
    gate_start = cutoff - gate.GATE_DAYS * DAY
    twin = train.fit(rows, units, gate_start, trained_at, source, with_risk=False)
    twin_p = predictor(twin)
    vs_td = evaluate(twin_p, full_slice(rows, gate_start, cutoff))
    e = vs_td["events"]
    out: dict[str, Any] = {
        "twin": {k: twin[k] for k in ("data_through", "calibrated", "platt")},
        "vs_td": strip(vs_td),
        "bootstrap_td": paired_bootstrap(e["model"], e["td"], e["unit"]),
        "vs_live": None,
        "bootstrap_live": None,
        "live_calibration": None,
    }
    cal = calibration_rows(rows, units, cutoff)
    out["calibration"] = None
    if cal["y"].sum() >= MIN_CALIBRATION_POSITIVES:
        cal_start = cutoff - CALIBRATION_DAYS * DAY
        cal_twin = train.fit(
            rows, units, cal_start, trained_at, source, with_risk=False
        )
        out["calibration"] = calibration(predictor(cal_twin)(cal), cal["y"].to_numpy())
    pr = full_slice(rows, gate_start, cutoff)
    pr = pr[(pr["kind"] == PR_TD_OFF) & pr["y"].notna()]
    out["pr_calibration"] = calibration(twin_p(pr), pr["y"].to_numpy())
    if live is not None:
        live_from = max(
            epoch(gate.parse_time(live["data_through"]).replace(tzinfo=None)),
            gate_start,
        )
        part = full_slice(rows, live_from, cutoff)
        m_twin, m_live = evaluate(twin_p, part), evaluate(predictor(live), part)
        ev = m_twin["events"]
        out["vs_live"] = {
            "since": train.iso(live_from),
            "twin": strip(m_twin),
            "live": strip(m_live),
        }
        boot = paired_bootstrap(ev["model"], m_live["events"]["model"], ev["unit"])
        out["bootstrap_live"] = {**(boot or {}), "pr_events": ev["kind"].count("pr")}
        out["live_calibration"] = calibration(predictor(live)(cal), cal["y"].to_numpy())
    passed, reasons = gate.gate(
        out["bootstrap_td"], out["bootstrap_live"], out["calibration"]
    )
    if live is not None:
        reasons += gate.drift(out["live_calibration"])
    return {"passed": passed, "reasons": reasons, **out}
