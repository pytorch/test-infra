"""Training: the scorer (gradient-boosted trees over spec.SCORER_FEATURES), its Platt
scaling by a twin fit before the calibration slice, and the risk score that sets each
change's test-time budget, exported as td_scorer.json (format 1). The exported,
rounded document is the model of record: everything downstream (the gate) scores that
document."""

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from torchci.td.labels.schema import DAY, MAIN
from torchci.td.scorer import model_json, spec


logger = logging.getLogger(__name__)

SEED = 0
SCORER_PARAMS = {
    "max_depth": 3,
    "learning_rate": 0.05,
    "max_iter": 300,
    "min_samples_leaf": 200,
    "l2_regularization": 1.0,
    "early_stopping": True,
    "validation_fraction": 0.1,
    "random_state": SEED,
}
# Calibration slices tried in turn, until the twin's training rows and the slice both
# hold MIN_POSITIVES positives.
CALIB_DAYS = (28, 42, 56)
MIN_POSITIVES = 10
PLATT_C = 1e6
CLIP = 1e-7
RISK_C = 0.1
RISK_MAX_ITER = 2000
DECIMALS = 9
WIDTH = 0.10
TARGET_BASE = round(model_json.SHARE_FLOOR + WIDTH / 2, DECIMALS)
QUANTILE_DAYS = 90
# sklearn splits "NaN vs any value" at an infinite threshold; the format holds finite
# numbers only, and every feature value is far below this one.
MAX_THRESHOLD = 1e308


@dataclass(frozen=True)
class Platt:
    coef: float
    intercept: float
    calibrated: bool


IDENTITY = Platt(1.0, 0.0, False)


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def matrix(frame: pd.DataFrame, features: Any = spec.SCORER_FEATURES) -> np.ndarray:
    return frame[list(features)].to_numpy(dtype=np.float64)


def training_rows(rows: pd.DataFrame, units: pd.DataFrame, before: int) -> pd.DataFrame:
    """Labelled rows of `train_ok` units from before `before`. Full rows (the gate's
    slice keeps every candidate at weight 1) train too: their weights are consistent with
    the subsampled rows', and leaving them out would drop the most recent weeks."""
    ok = units.loc[units["train_ok"].astype(bool), "unit_id"]
    keep = rows["unit_id"].isin(ok) & (rows["time"] < before) & rows["y"].notna()
    return rows[keep]


def landed_units(units: pd.DataFrame, start: Optional[int], end: int) -> pd.DataFrame:
    """The landed (main) `train_ok` changes in [start, end); no lower bound without
    `start`."""
    keep = (
        (units["kind"] == MAIN) & units["train_ok"].astype(bool) & (units["time"] < end)
    )
    if start is not None:
        keep &= units["time"] >= start
    return units[keep]


def fit_scorer(train: pd.DataFrame) -> HistGradientBoostingClassifier:
    x = matrix(train)
    # scikit-learn 1.9 cannot bin a column without a single value ("window shape cannot
    # be larger than input array shape"), which the failure-history features are before
    # that history starts. A constant column trains the same trees: neither is split on.
    empty = np.isnan(x).all(axis=0)
    if empty.any():
        x = np.where(empty, 0.0, x)
    model = HistGradientBoostingClassifier(**SCORER_PARAMS)
    model.fit(
        x,
        train["y"].to_numpy(dtype=np.int64),
        sample_weight=train["w"].to_numpy(dtype=np.float64),
    )
    return model


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, CLIP, 1 - CLIP)
    return np.log(p / (1 - p))


def fit_platt(rows: pd.DataFrame, units: pd.DataFrame, end: int) -> Platt:
    """Platt scaling on the landed changes of the last CALIB_DAYS before `end`, of a twin
    fit only on rows before that slice; identity (uncalibrated) when no slice has enough
    positives."""
    for days in CALIB_DAYS:
        start = end - days * DAY
        twin_rows = training_rows(rows, units, start)
        main = landed_units(units, start, end)["unit_id"]
        calib = rows[rows["unit_id"].isin(main) & rows["y"].notna()]
        if twin_rows["y"].sum() < MIN_POSITIVES or calib["y"].sum() < MIN_POSITIVES:
            continue
        twin = fit_scorer(twin_rows)
        platt = LogisticRegression(C=PLATT_C)
        platt.fit(
            logit(twin.predict_proba(matrix(calib))[:, 1]).reshape(-1, 1),
            calib["y"].to_numpy(dtype=np.int64),
            sample_weight=calib["w"].to_numpy(dtype=np.float64),
        )
        logger.info("Platt on the last %d days: %d positives", days, calib["y"].sum())
        return Platt(float(platt.coef_[0][0]), float(platt.intercept_[0]), True)
    logger.warning("too few positives to calibrate: identity Platt")
    return IDENTITY


def scorer_block(model: HistGradientBoostingClassifier) -> dict[str, Any]:
    """The fitted trees as the format's parallel lists (leaves: feature -1)."""
    if model.n_trees_per_iteration_ != 1:
        raise ValueError("expected a binary classifier")
    trees = []
    for (predictor,) in model._predictors:
        nodes = predictor.nodes
        if nodes["is_categorical"].any():
            raise ValueError("categorical splits are not part of the format")
        leaf = nodes["is_leaf"].astype(bool)
        trees.append(
            {
                "feature": [
                    -1 if f else int(i) for f, i in zip(leaf, nodes["feature_idx"])
                ],
                "threshold": [
                    0.0 if f else round_up(min(float(t), MAX_THRESHOLD))
                    for f, t in zip(leaf, nodes["num_threshold"])
                ],
                "missing_left": [
                    bool(m) and not f for f, m in zip(leaf, nodes["missing_go_to_left"])
                ],
                "left": [0 if f else int(c) for f, c in zip(leaf, nodes["left"])],
                "right": [0 if f else int(c) for f, c in zip(leaf, nodes["right"])],
                "value": [float(v) if f else 0.0 for f, v in zip(leaf, nodes["value"])],
                "leaf": [bool(f) for f in leaf],
            }
        )
    return {"baseline": float(model._baseline_prediction.ravel()[0]), "trees": trees}


def round_up(threshold: float) -> float:
    """The smallest DECIMALS-place value >= `threshold`. sklearn's thresholds often equal
    a training value (x <= t goes left); rounding them down would send those right."""
    r = round(threshold, DECIMALS)
    while r < threshold:
        r = round(r + 10.0**-DECIMALS, DECIMALS)
    return r


def rounded(obj: Any) -> Any:
    """Every float (in dicts and lists too) rounded to DECIMALS places."""
    if isinstance(obj, dict):
        return {k: rounded(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [rounded(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return round(float(obj), DECIMALS)
    return obj


def export(
    model: HistGradientBoostingClassifier,
    platt: Platt,
    risk: Optional[dict[str, Any]],
    trained_at: str,
    data_through: int,
    source: dict[str, Any],
) -> dict[str, Any]:
    """td_scorer.json (format 1), floats rounded, validated and free of digit runs."""
    doc = rounded(
        {
            "format": spec.FORMAT,
            "enabled": True,
            "trained_at": trained_at,
            "data_through": iso(data_through),
            "source": source,
            "calibrated": platt.calibrated,
            "features": list(spec.SCORER_FEATURES),
            "scorer": scorer_block(model),
            "platt": {"coef": platt.coef, "intercept": platt.intercept, "clip": CLIP},
            **({"risk": risk} if risk is not None else {}),
            "gate": {},
        }
    )
    problem = model_json.validate(doc)
    if problem:
        logger.warning("risk block dropped: %s", problem)
        del doc["risk"]
    if model_json.has_digit_run(json.dumps(doc)):
        raise ValueError("the exported model holds a run of 15 or more digits")
    return doc


def predict_matrix(doc: dict[str, Any], x: np.ndarray) -> np.ndarray:
    """model_json.predict vectorised: the same comparisons and the same order of float64
    additions, so the raw scores are identical; `x` holds doc["features"] in order."""
    scorer, platt = doc["scorer"], doc["platt"]
    raw = np.full(len(x), float(scorer["baseline"]))
    for tree in scorer["trees"]:
        feature = np.asarray(tree["feature"], dtype=np.intp)
        threshold = np.asarray(tree["threshold"], dtype=np.float64)
        missing = np.asarray(tree["missing_left"], dtype=bool)
        left = np.asarray(tree["left"], dtype=np.intp)
        right = np.asarray(tree["right"], dtype=np.intp)
        leaf = np.asarray(tree["leaf"], dtype=bool)
        node = np.zeros(len(x), dtype=np.intp)
        for _ in range(model_json.MAX_DEPTH):
            active = np.nonzero(~leaf[node])[0]
            if not len(active):
                break
            n = node[active]
            v = x[active, feature[n]]
            with np.errstate(invalid="ignore"):
                go_left = np.where(np.isnan(v), missing[n], v <= threshold[n])
            node[active] = np.where(go_left, left[n], right[n])
        raw += np.asarray(tree["value"], dtype=np.float64)[node]
    clip = platt["clip"]
    p_raw = np.clip(sigmoid(raw), clip, 1 - clip)
    return sigmoid(platt["coef"] * np.log(p_raw / (1 - p_raw)) + platt["intercept"])


def sigmoid(s: np.ndarray) -> np.ndarray:
    with np.errstate(over="ignore"):
        return np.where(s < -model_json.EXP_LIMIT, 0.0, 1.0 / (1.0 + np.exp(-s)))


def risk_table(units: pd.DataFrame, end: int) -> pd.DataFrame:
    """The landed `train_ok` changes before `end` with their risk inputs and weights from
    the unit table, and y = it newly broke a test."""
    table = landed_units(units, None, end)
    return table.assign(y=(table["n_positives"] > 0).astype(np.int64))


def order_statistics(
    values: np.ndarray, k: int = model_json.MAX_QUANTILES
) -> list[float]:
    """Up to `k` evenly spaced order statistics of `values`."""
    ordered = np.sort(values)
    if len(ordered) <= k:
        return ordered.tolist()
    return ordered[np.round(np.linspace(0, len(ordered) - 1, k)).astype(int)].tolist()


def share_range(base: float) -> tuple[float, float]:
    """(share_min, share_max) of the budget at `base`, rounded as the file holds them."""
    return round(base - WIDTH / 2, DECIMALS), round(base + WIDTH / 2, DECIMALS)


def fit_risk(
    table: pd.DataFrame,
    end: int,
    paths: Optional[dict[str, Any]] = None,
    base: float = TARGET_BASE,
) -> Optional[dict[str, Any]]:
    """The risk block: a standardised logistic regression on the changes in `table`,
    each weighing its `uw` (the row builder's subsampling); the share mapping's quantiles,
    the order statistics of the risks of the changes of the QUANTILE_DAYS before `end`,
    each repeated by its `uw`; the budget's range at `base`; and the served path table
    (pathrisk.table). None when the table holds one class only."""
    if table["y"].nunique() < 2:
        logger.warning("risk: %d changes of one class only, no risk block", len(table))
        return None
    names = list(spec.RISK_FEATURES)
    frame = table[names].astype(np.float64)
    fill = frame.median().fillna(0.0)
    x = frame.fillna(fill).to_numpy()
    scaler = StandardScaler().fit(x)
    weight = table["uw"].to_numpy(dtype=np.float64)
    model = LogisticRegression(
        C=RISK_C, class_weight="balanced", max_iter=RISK_MAX_ITER
    ).fit(scaler.transform(x), table["y"].to_numpy(), sample_weight=weight)
    risks = model.predict_proba(scaler.transform(x))[:, 1]
    recent = (table["time"] >= end - QUANTILE_DAYS * DAY).to_numpy()
    repeats = np.rint(weight[recent]).astype(np.int64)
    share_min, share_max = share_range(base)
    return {
        "features": names,
        "fill": fill.tolist(),
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "coef": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "quantiles": order_statistics(np.repeat(risks[recent], repeats)),
        "share_min": share_min,
        "share_max": share_max,
        **({"paths": paths} if paths is not None else {}),
    }


def fit(
    rows: pd.DataFrame,
    units: pd.DataFrame,
    end: int,
    trained_at: str,
    source: dict[str, Any],
    with_risk: bool = True,
    paths: Optional[dict[str, Any]] = None,
    base: float = TARGET_BASE,
) -> dict[str, Any]:
    """The exported model trained on everything before `end`: scorer, Platt and (with
    `with_risk`) the risk block fit on the unit table's landed changes, with the budget
    at `base` and serving the path table `paths` (the block is dropped without one: its
    path features need it)."""
    train = training_rows(rows, units, end)
    logger.info("scorer: %d rows, %d positives", len(train), int(train["y"].sum()))
    model = fit_scorer(train)
    platt = fit_platt(rows, units, end)
    risk = fit_risk(risk_table(units, end), end, paths, base) if with_risk else None
    return export(model, platt, risk, trained_at, end, source)
