"""The gate's replay: TD's 25% count cut and the model's time budget (the cut step
pytorch's run_test.py takes) per unit, recall over failure events, the paired
bootstrap over PRs and the search for the budget's base; `run_gate` puts them together
with calibration for the refit."""

import math
from bisect import bisect_left
from typing import Any, Callable, cast, Mapping, Optional, Sequence

import numpy as np
import pandas as pd
from torchci.greenlight_replay.compare_stats import wilson
from torchci.td.labels.schema import DAY, epoch, MAIN, PR_TD_OFF
from torchci.td.llm.replay import cut_position
from torchci.td.scorer import gate, model_json, pathrisk, spec, train
from torchci.td.scorer.calibration import (
    calibration,
    CALIBRATION_DAYS,
    calibration_rows,
    MIN_CALIBRATION_POSITIVES,
)


MAX_BASE = round(model_json.SHARE_CEILING - train.WIDTH / 2, train.DECIMALS)
BASE_STEP = 0.01
# The base search's bar: the budget's PR recall minus TD's has a paired bootstrap lower
# bound of at least -MAX_LOSS.
MAX_LOSS = 0.01
BASES = tuple(
    round(train.TARGET_BASE + i * BASE_STEP, train.DECIMALS)
    for i in range(round((MAX_BASE - train.TARGET_BASE) / BASE_STEP) + 1)
)
BOOTSTRAP = 1000
CONFIDENCE = 0.95
# Event kinds: a PR-specific failure on a TD-off PR job, and a fresh failure on main.
EVENT_KINDS = {PR_TD_OFF: "pr", MAIN: "main"}

ShareOf = Callable[[float], float]


def cut_count(n: int) -> int:
    """How many of `n` tests TD's cut keeps (`get_top_per_tests`), at most all of them."""
    return min(n, cut_position(n) + 1)


def need(
    tests: Sequence[str], p: Mapping[str, float], cost: Mapping[str, float]
) -> Optional[dict[str, float]]:
    """Per test, the share of the tests' total cost ranked ahead of it by (-p / cost,
    name). The budget cut at a share keeps the tests whose need is below it: tests are
    taken while the cost taken is below share x total, so the one that crosses it is
    kept. None when a cost is unknown (NaN): pytorch then takes TD's cut."""
    if any(math.isnan(cost[t]) for t in tests):
        return None
    total = math.fsum(cost[t] for t in tests)
    out, before = {}, 0.0
    for t in sorted(tests, key=lambda t: (-p[t] / cost[t], t)):
        out[t] = before / total
        before += cost[t]
    return out


def spread(base: float) -> ShareOf:
    """The share at risk percentile F of the budget at `base` (train.share_range)."""
    lo, hi = train.share_range(base)
    return lambda f: model_json.share(lo, hi, f)


def flat(share: float) -> ShareOf:
    return lambda f: share


def cluster(unit_id: str, kind: str) -> str:
    """The bootstrap's resampling cluster of a unit's events: its PR for a TD-off PR unit
    (torchci.td.labels ids those "p:<pr>:..."), else the unit."""
    if kind == PR_TD_OFF and unit_id.startswith("p:"):
        return "pr:" + unit_id.split(":")[1]
    return unit_id


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
    predict_fn: Callable[[pd.DataFrame], np.ndarray],
    full_rows: pd.DataFrame,
    f_of: Optional[Mapping[str, float]] = None,
) -> dict[str, Any]:
    """Per unit of `full_rows` (every candidate of the unit): p from `predict_fn`, TD's
    cut and each test's need with the rows' `cost`. Events: each (TD-off PR unit,
    positive file) and each (main unit, fresh positive file), with TD's hit, the file's
    need, the unit's risk percentile from `f_of` (NaN without) and its cluster. TD's
    recall per kind and pooled with Wilson intervals and its mean shares of tests and
    cost; the events and the units' needs for with_model's budget cut."""
    rows = full_rows[full_rows["kind"].isin(list(EVENT_KINDS))]
    p_all = predict_fn(rows) if len(rows) else np.zeros(0)
    f_of = f_of or {}
    events: dict[str, list[Any]] = {
        k: [] for k in ("unit", "kind", "cluster", "td", "need", "f")
    }
    cuts: dict[str, list[Any]] = {k: [] for k in ("kind", "f", "needs", "td", "test")}
    no_costs = 0
    groups = rows.groupby(["unit_id", "kind"], sort=True).indices
    for key, idx in groups.items():
        uid, kind = (str(k) for k in cast(tuple, key))
        unit = rows.iloc[idx]
        tests = unit["test"].tolist()
        p = dict(zip(tests, p_all[idx]))
        cost = dict(zip(tests, unit["cost"].astype(float)))
        order = td_order(unit)
        td_cut = set(order[: cut_count(len(order))])
        needs = need(tests, p, cost)
        no_costs += needs is None
        k, f = EVENT_KINDS[kind], float(f_of.get(uid, math.nan))
        cuts["kind"].append(k)
        cuts["f"].append(f)
        cuts["needs"].append(None if needs is None else [*sorted(needs.values()), 1.0])
        cuts["td"].append(sum(cost[t] for t in td_cut) / sum(cost.values()))
        cuts["test"].append(len(td_cut) / len(order))
        failed = unit["y"] == 1
        if kind == MAIN:
            failed &= unit["fresh"].astype(bool)
        for test in sorted(unit.loc[failed, "test"]):
            events["unit"].append(uid)
            events["kind"].append(k)
            events["cluster"].append(cluster(uid, kind))
            events["td"].append(test in td_cut)
            events["need"].append(None if needs is None else needs[test])
            events["f"].append(f)
    out: dict[str, Any] = {"units": len(cuts["kind"]), "td_cut_no_costs": no_costs}
    for k in (*EVENT_KINDS.values(), "pooled"):
        pick = [i for i, e in enumerate(events["kind"]) if k in ("pooled", e)]
        mine = [i for i, e in enumerate(cuts["kind"]) if k in ("pooled", e)]
        out[k] = {
            "units": len(mine),
            "test_share": mean([cuts["test"][i] for i in mine]),
            "td": {
                **rate(sum(events["td"][i] for i in pick), len(pick)),
                "cost_share": mean([cuts["td"][i] for i in mine]),
            },
        }
    out["events"] = events
    out["cuts"] = cuts
    return out


def hits(events: Mapping[str, Sequence[Any]], share_of: ShareOf) -> list[bool]:
    """Per event, whether the budget cut at share_of(F) keeps its file (TD's cut when
    its unit's costs are unknown)."""
    return [
        td if n is None else n < share_of(f)
        for n, td, f in zip(events["need"], events["td"], events["f"])
    ]


def cost_share(needs: Sequence[float], share: float) -> float:
    """The share of the unit's cost the budget cut keeps: the need of the first test it
    leaves out (`needs` ascending, ending with 1.0)."""
    return needs[bisect_left(needs, share)]


def with_model(metrics: dict[str, Any], share_of: ShareOf) -> dict[str, Any]:
    """`metrics` (evaluate) without its events, plus per kind the budget cut at
    share_of(F) as "model": its recall and mean share of cost."""
    e, c = metrics["events"], metrics["cuts"]
    hit = hits(e, share_of)
    out = strip(metrics)
    for k in (*EVENT_KINDS.values(), "pooled"):
        pick = [i for i, kk in enumerate(e["kind"]) if k in ("pooled", kk)]
        shares = [
            c["td"][i]
            if c["needs"][i] is None
            else cost_share(c["needs"][i], share_of(c["f"][i]))
            for i, kk in enumerate(c["kind"])
            if k in ("pooled", kk)
        ]
        out[k] = {
            **out[k],
            "model": {
                **rate(sum(hit[i] for i in pick), len(pick)),
                "cost_share": mean(shares),
            },
        }
    return out


def known_pr_events(events: Mapping[str, Sequence[Any]]) -> int:
    """The PR events whose unit has test times (a need)."""
    return sum(
        k == "pr" and n is not None for k, n in zip(events["kind"], events["need"])
    )


def pr_events(events: Mapping[str, Sequence[Any]]) -> dict[str, list[Any]]:
    pick = [i for i, k in enumerate(events["kind"]) if k == "pr"]
    return {k: [v[i] for i in pick] for k, v in events.items()}


def search(events: Mapping[str, Sequence[Any]]) -> Optional[float]:
    """The smallest of BASES at which the budget cut keeps PR recall within MAX_LOSS of
    TD's cut: the paired bootstrap of its PR events (resampling PRs) has a lower bound
    of at least -MAX_LOSS. None when no base does, or with fewer than
    gate.MIN_LIVE_PR_EVENTS PR events with test times (known_pr_events)."""
    pr = pr_events(events)
    if known_pr_events(pr) < gate.MIN_LIVE_PR_EVENTS:
        return None
    for base in BASES:
        boot = paired_bootstrap(hits(pr, spread(base)), pr["td"], pr["cluster"])
        if boot is not None and boot["lo"] >= -MAX_LOSS:
            return base
    return None


def paired_bootstrap(
    hits_a: Sequence[bool],
    hits_b: Sequence[bool],
    clusters: Sequence[str],
    n: int = BOOTSTRAP,
    seed: int = 0,
) -> Optional[dict[str, Any]]:
    """Pooled recall of a minus b with a CONFIDENCE interval, resampling clusters (an
    event's cluster is `clusters[i]`); None without events."""
    if not len(clusters):
        return None
    _, inverse = np.unique(np.asarray(clusters), return_inverse=True)
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
        "clusters": len(count),
    }


def predictor(doc: dict[str, Any]) -> Callable[[pd.DataFrame], np.ndarray]:
    """p of a frame's rows under an exported model (the model of record)."""
    return lambda frame: train.predict_matrix(doc, train.matrix(frame, doc["features"]))


def strip(metrics: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in metrics.items() if k not in ("events", "cuts")}


def full_slice(rows: pd.DataFrame, start: int, stop: int) -> pd.DataFrame:
    keep = rows["full"].astype(bool) & (rows["time"] >= start) & (rows["time"] < stop)
    return rows[keep]


def percentiles(
    doc: dict[str, Any], units: pd.DataFrame, start: int, stop: int
) -> Optional[dict[str, float]]:
    """Per unit in [start, stop), the risk percentile F under `doc`'s risk block from the
    unit table's inputs; None when the model has no risk block."""
    if "risk" not in doc:
        return None
    window = units[(units["time"] >= start) & (units["time"] < stop)]
    names = list(spec.RISK_FEATURES)
    return {
        uid: model_json.risk(doc, dict(zip(names, map(float, values))))[1]
        for uid, values in zip(window["unit_id"], window[names].to_numpy())
    }


def run_gate(
    rows: pd.DataFrame,
    units: pd.DataFrame,
    cutoff: int,
    live: Optional[dict[str, Any]],
    trained_at: str,
    source: dict[str, Any],
    history: Optional[pathrisk.History] = None,
) -> dict[str, Any]:
    """A twin of the model, trained before the last GATE_DAYS before `cutoff` with its
    risk score and path table (from `history`) as of then. On those days: the search
    for the budget's base against TD's cut (search), and the budget at that base (else
    MAX_BASE) against TD. Against the live model, on the units after both models' data:
    both at a flat share equal to that base. On the last CALIBRATION_DAYS: the
    calibration of a second twin trained before them (out of sample), fit only when they
    hold enough positives, and the live model's drift. As information only, the twin's
    calibration on the TD-off PR units of the last GATE_DAYS: those exist only when the
    job had a PR-specific failure, so their ratio is not comparable to 1."""
    gate_start = cutoff - gate.GATE_DAYS * DAY
    paths = None if history is None else pathrisk.table(history, gate_start)
    twin = train.fit(rows, units, gate_start, trained_at, source, paths=paths)
    twin_p = predictor(twin)
    f_of = percentiles(twin, units, gate_start, cutoff)
    vs_td = evaluate(twin_p, full_slice(rows, gate_start, cutoff), f_of)
    base = search(vs_td["events"]) if f_of is not None else None
    shown = MAX_BASE if base is None else base
    pr = pr_events(vs_td["events"])
    budget: dict[str, Any] = {
        "risk": f_of is not None,
        "base": base,
        "shown": None,
        "max_base": MAX_BASE,
        "max_loss": MAX_LOSS,
        "known_pr_events": known_pr_events(pr),
        "bootstrap": None,
    }
    if f_of is not None:
        budget.update(
            shown=shown,
            range=train.share_range(shown),
            bootstrap=paired_bootstrap(
                hits(pr, spread(shown)), pr["td"], pr["cluster"]
            ),
        )
    out: dict[str, Any] = {
        "twin": {k: twin[k] for k in ("data_through", "calibrated", "platt")},
        "budget": budget,
        "vs_td": strip(vs_td) if f_of is None else with_model(vs_td, spread(shown)),
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
    pr_rows = full_slice(rows, gate_start, cutoff)
    pr_rows = pr_rows[(pr_rows["kind"] == PR_TD_OFF) & pr_rows["y"].notna()]
    out["pr_calibration"] = calibration(twin_p(pr_rows), pr_rows["y"].to_numpy())
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
            "share": shown,
            "twin": with_model(m_twin, flat(shown)),
            "live": with_model(m_live, flat(shown)),
        }
        boot = paired_bootstrap(
            hits(ev, flat(shown)), hits(m_live["events"], flat(shown)), ev["cluster"]
        )
        out["bootstrap_live"] = {**(boot or {}), "pr_events": ev["kind"].count("pr")}
        out["live_calibration"] = calibration(predictor(live)(cal), cal["y"].to_numpy())
    passed, reasons = gate.gate(budget, out["bootstrap_live"], out["calibration"])
    if live is not None:
        reasons += gate.drift(out["live_calibration"])
    return {"passed": passed, "reasons": reasons, **out}
