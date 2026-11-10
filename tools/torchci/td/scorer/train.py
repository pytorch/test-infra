"""Training: the scorer (gradient-boosted trees over spec.SCORER_FEATURES), its Platt
scaling by a twin fit before the calibration slice, and the shadow risk score, exported
as td_scorer.json (format 1). The exported, rounded document is the model of record:
everything downstream (the risk model's inputs, the gate) scores that document."""

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
from torchci.td.scorer.features import NEG_KEEP


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
SHARE_MIN, SHARE_MAX = 0.10, 0.20
DECIMALS = 9
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


def risk_table(
    rows: pd.DataFrame, units: pd.DataFrame, end: int, doc: dict[str, Any]
) -> pd.DataFrame:
    """Per landed `train_ok` change before `end` that has rows: the risk features and
    y = it newly broke a test. sum_p, max_p and max_llm come from the exported scorer's
    p on the change's own rows (in-sample for the scorer); sum_p reweights the subsampled
    negatives by 1 / NEG_KEEP so it estimates the sum over every candidate."""
    ids = landed_units(units, None, end)
    sub = rows[rows["unit_id"].isin(ids["unit_id"])]
    p = predict_matrix(doc, matrix(sub, doc["features"]))
    within = np.where(~sub["full"].astype(bool) & (sub["y"] == 0), 1 / NEG_KEEP, 1.0)
    agg = (
        pd.DataFrame(
            {
                "unit_id": sub["unit_id"].to_numpy(),
                "wp": p * within,
                "p": p,
                "llm": sub["llm_n"].to_numpy(dtype=np.float64),
            }
        )
        .groupby("unit_id")
        .agg(sum_p=("wp", "sum"), max_p=("p", "max"), max_llm=("llm", "max"))
        .reset_index()
    )
    table = ids.merge(agg, on="unit_id", how="inner")
    return table.assign(y=(table["n_positives"] > 0).astype(np.int64))


def order_statistics(
    values: np.ndarray, k: int = model_json.MAX_QUANTILES
) -> list[float]:
    """Up to `k` evenly spaced order statistics of `values`."""
    ordered = np.sort(values)
    if len(ordered) <= k:
        return ordered.tolist()
    return ordered[np.round(np.linspace(0, len(ordered) - 1, k)).astype(int)].tolist()


def fit_risk(table: pd.DataFrame) -> Optional[dict[str, Any]]:
    """The risk block: a standardised logistic regression on the changes in `table`, and
    the order statistics of their risks for the share mapping; None when the table holds
    one class only."""
    if table["y"].nunique() < 2:
        logger.warning("risk: %d changes of one class only, no risk block", len(table))
        return None
    names = list(spec.RISK_FEATURES)
    frame = table[names].astype(np.float64)
    fill = frame.median().fillna(0.0)
    x = frame.fillna(fill).to_numpy()
    scaler = StandardScaler().fit(x)
    model = LogisticRegression(
        C=RISK_C, class_weight="balanced", max_iter=RISK_MAX_ITER
    ).fit(scaler.transform(x), table["y"].to_numpy())
    risks = model.predict_proba(scaler.transform(x))[:, 1]
    return {
        "features": names,
        "fill": fill.tolist(),
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "coef": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "quantiles": order_statistics(risks),
        "share_min": SHARE_MIN,
        "share_max": SHARE_MAX,
    }


def fit(
    rows: pd.DataFrame,
    units: pd.DataFrame,
    end: int,
    trained_at: str,
    source: dict[str, Any],
    with_risk: bool = True,
) -> dict[str, Any]:
    """The exported model trained on everything before `end`: scorer, Platt and (with
    `with_risk`) the risk block fit on the exported scorer's predictions."""
    train = training_rows(rows, units, end)
    logger.info("scorer: %d rows, %d positives", len(train), int(train["y"].sum()))
    model = fit_scorer(train)
    platt = fit_platt(rows, units, end)
    doc = export(model, platt, None, trained_at, end, source)
    if with_risk:
        risk = fit_risk(risk_table(rows, units, end, doc))
        doc = export(model, platt, risk, trained_at, end, source)
    return doc
