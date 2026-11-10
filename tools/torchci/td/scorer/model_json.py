"""td_scorer.json's validation and its reference evaluator, in the stdlib only and in the
exact order of operations pytorch's TD job uses. pytorch falls back to TD's own cut on any
problem this module raises."""

import math
import re
from bisect import bisect_right
from typing import Any, Mapping, Optional, Sequence

from torchci.td.scorer import spec


MAX_FEATURES = 200
MAX_TREES = 1000
MAX_TREE_NODES = 255
MAX_DEPTH = 8
MAX_TOTAL_NODES = 20000
MIN_QUANTILES, MAX_QUANTILES = 2, 2001
MAX_CLIP = 0.01
MAX_TRAINED_AT = 32
# exp(-x) overflows a float64 past x ~ 709.
EXP_LIMIT = 700.0
TREE_KEYS = ("feature", "threshold", "missing_left", "left", "right", "value", "leaf")
RISK_LISTS = ("fill", "mean", "scale", "coef")
# The org's push protection blocks pushed files holding a run of this many digits.
DIGIT_RUN = re.compile(r"[0-9]{15,}")


class InvalidModel(ValueError):
    """The model cannot be used; the message is the fallback reason."""


class ModelDisabled(InvalidModel):
    """The model is switched off (`"enabled": false`)."""


def is_number(x: Any) -> bool:
    """A finite int or float; bools are not numbers."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def is_index(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def has_digit_run(text: str) -> bool:
    return DIGIT_RUN.search(text) is not None


def _check(ok: bool, reason: str) -> None:
    if not ok:
        raise InvalidModel(reason)


def _check_tree(tree: Any, i: int, n_features: int) -> int:
    """Validates tree `i`; returns its node count."""
    _check(isinstance(tree, dict), f"tree {i}: not an object")
    lists = [tree.get(k) for k in TREE_KEYS]
    _check(all(isinstance(v, list) for v in lists), f"tree {i}: missing lists")
    n = len(lists[0])
    _check(1 <= n <= MAX_TREE_NODES, f"tree {i}: {n} nodes")
    _check(all(len(v) == n for v in lists), f"tree {i}: unequal lists")
    feature, threshold, missing, left, right, value, leaf = lists
    depth = [0] * n
    for j in range(n):
        _check(isinstance(leaf[j], bool), f"tree {i} node {j}: leaf not a bool")
        _check(isinstance(missing[j], bool), f"tree {i} node {j}: missing not a bool")
        _check(
            all(is_index(v[j]) for v in (feature, left, right)),
            f"tree {i} node {j}: index not an int",
        )
        _check(
            is_number(threshold[j]) and is_number(value[j]),
            f"tree {i} node {j}: number not finite",
        )
        if leaf[j]:
            continue
        _check(0 <= feature[j] < n_features, f"tree {i} node {j}: bad feature")
        for child in (left[j], right[j]):
            _check(j < child < n, f"tree {i} node {j}: bad child")
            # Children always follow their parent, so one forward pass finds the depth.
            depth[child] = max(depth[child], depth[j] + 1)
            _check(depth[child] <= MAX_DEPTH, f"tree {i}: deeper than {MAX_DEPTH}")
    return n


def risk_problem(risk: Any) -> Optional[str]:
    """Why the risk block is unusable, or None; a bad block disables only the risk score."""
    if not isinstance(risk, dict):
        return "risk: not an object"
    names = risk.get("features")
    if (
        not isinstance(names, list)
        or not names
        or len(set(map(str, names))) != len(names)
        or not all(isinstance(f, str) and f in spec.RISK_FEATURES for f in names)
    ):
        return "risk: bad features"
    for key in RISK_LISTS:
        values = risk.get(key)
        if not isinstance(values, list) or len(values) != len(names):
            return f"risk: bad {key}"
        if not all(is_number(v) for v in values):
            return f"risk: {key} not finite"
    if not all(s > 0 for s in risk["scale"]):
        return "risk: scale not positive"
    if not is_number(risk.get("intercept")):
        return "risk: bad intercept"
    q = risk.get("quantiles")
    if not isinstance(q, list) or not MIN_QUANTILES <= len(q) <= MAX_QUANTILES:
        return "risk: bad quantiles"
    if not all(is_number(v) and 0 <= v <= 1 for v in q):
        return "risk: quantile outside [0, 1]"
    if any(a > b for a, b in zip(q, q[1:])):
        return "risk: quantiles not ascending"
    lo: Any = risk.get("share_min")
    hi: Any = risk.get("share_max")
    if not (is_number(lo) and is_number(hi) and 0 <= lo <= hi <= 1):
        return "risk: bad shares"
    return None


def validate(doc: Any) -> Optional[str]:
    """Raises InvalidModel (ModelDisabled when switched off) when the model cannot rank;
    returns why the risk block is unusable, or None when it is fine or absent."""
    _check(isinstance(doc, dict), "not an object")
    _check(is_index(doc.get("format")) and doc["format"] == spec.FORMAT, "bad format")
    if doc.get("enabled") is not True:
        raise ModelDisabled("disabled")
    trained_at = doc.get("trained_at")
    _check(
        isinstance(trained_at, str) and len(trained_at) <= MAX_TRAINED_AT,
        "bad trained_at",
    )
    names = doc.get("features")
    _check(
        isinstance(names, list) and 1 <= len(names) <= MAX_FEATURES,
        "bad features",
    )
    _check(
        all(isinstance(f, str) for f in names) and len(set(names)) == len(names),
        "features not unique strings",
    )
    unknown = [f for f in names if f not in spec.SCORER_FEATURES]
    _check(not unknown, f"unknown features: {unknown}")
    scorer = doc.get("scorer")
    _check(isinstance(scorer, dict), "no scorer")
    _check(is_number(scorer.get("baseline")), "bad baseline")
    trees = scorer.get("trees")
    _check(isinstance(trees, list) and 1 <= len(trees) <= MAX_TREES, "bad trees")
    total = sum(_check_tree(t, i, len(names)) for i, t in enumerate(trees))
    _check(total <= MAX_TOTAL_NODES, f"{total} nodes")
    platt = doc.get("platt")
    _check(isinstance(platt, dict), "no platt")
    _check(
        is_number(platt.get("coef")) and is_number(platt.get("intercept")),
        "bad platt",
    )
    clip = platt.get("clip")
    _check(is_number(clip) and 0 < clip < MAX_CLIP, "bad platt clip")
    risk = doc.get("risk")
    return None if risk is None else risk_problem(risk)


def sigmoid(s: float) -> float:
    return 0.0 if s < -EXP_LIMIT else 1.0 / (1.0 + math.exp(-s))


def raw_score(
    trees: Sequence[Mapping[str, Any]], baseline: float, row: Sequence[float]
) -> float:
    raw = baseline
    for tree in trees:
        feature, threshold, leaf = tree["feature"], tree["threshold"], tree["leaf"]
        n = 0
        while not leaf[n]:
            x = row[feature[n]]
            if x != x:
                n = tree["left"][n] if tree["missing_left"][n] else tree["right"][n]
            elif x <= threshold[n]:
                n = tree["left"][n]
            else:
                n = tree["right"][n]
        raw += tree["value"][n]
    return raw


def calibrate(doc: Mapping[str, Any], raw: float) -> float:
    """p from the trees' raw score: clipped sigmoid, logit, Platt."""
    platt = doc["platt"]
    clip = platt["clip"]
    p_raw = min(max(sigmoid(raw), clip), 1 - clip)
    z = math.log(p_raw / (1 - p_raw))
    p = sigmoid(platt["coef"] * z + platt["intercept"])
    if not (math.isfinite(p) and p > 0):
        raise InvalidModel("p not finite and positive")
    return p


def predict(doc: Mapping[str, Any], rows: Sequence[Sequence[float]]) -> list[float]:
    """p per row; each row lists the values of `doc["features"]` in that order (NaN for
    missing). `doc` must have passed `validate`."""
    scorer = doc["scorer"]
    return [
        calibrate(doc, raw_score(scorer["trees"], scorer["baseline"], row))
        for row in rows
    ]


def risk(
    doc: Mapping[str, Any], values: Mapping[str, float]
) -> tuple[float, float, float]:
    """(risk, its percentile F among the training changes, budget share) of one change;
    a missing or NaN value takes the block's fill."""
    r = doc["risk"]
    s = r["intercept"]
    for name, fill, mean, scale, coef in zip(
        r["features"], r["fill"], r["mean"], r["scale"], r["coef"]
    ):
        x = values.get(name, math.nan)
        x = fill if x != x else x
        s += coef * (x - mean) / scale
    value = sigmoid(s)
    f = bisect_right(r["quantiles"], value) / len(r["quantiles"])
    return value, f, r["share_min"] + (r["share_max"] - r["share_min"]) * f
