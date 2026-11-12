"""The model files `td-scorer.json` and `td-scorer-budget.json` (schema 2), the scorer's
p and the budget rule, as pytorch evaluates them.

pytorch's `tools/testing/target_determination/scorer_model.py` is the definition of the
format, of p and of the budget rule; this module writes that format and evaluates both
the same way, so the gate measures the file that ships. check-pytorch compares the
budget constants below with pytorch's.

The optional `budget` block, {"share": s, "spread": k, "cost_exponent": a}, carried only
by `td-scorer-budget.json` (`without_budget` gives `td-scorer.json`'s model), sizes each
job's cut: budget_share gives s * (1 + k * r), r the change's risk clamped to [-1, 1],
clamped to [MIN_SHARE, MAX_SHARE], as the share of the cost of all the job's files. A
change touching build paths, or with an unknown count of them or an unknown r, gets the
top of the window, s * (1 + k), clamped the same way; without a block there is no share
and the cut spends TD's cost.
"""

import json
import math
from typing import Any, Mapping, Optional, Sequence

import numpy as np
from torchci.td.scorer.store import SIG_DIGITS


SCHEMA = 2
Y_MIN, Y_MAX = 1e-6, 1 - 1e-6
MAX_POINTS = 512
MAX_BUILD_ENVS = 2000
MAX_TEST_CONFIGS = 500
MAX_NAME = 200
MIN_START_UP_SECONDS = 1.0
MAX_START_UP_SECONDS = 600.0

MIN_SHARE = 0.10
MAX_SHARE = 1.0
BUDGET_KEYS = ("share", "spread", "cost_exponent")
BUDGET_CONSTANTS = ("MIN_SHARE", "MAX_SHARE")
# s = 0.175 with k = 0.05 / 0.175, written at round_sig's precision: the window is
# [0.125, 0.225] of cost.
BUDGET = {"share": 0.175, "spread": 0.285714286, "cost_exponent": 0.5}
# What `TD_SCORER_BUDGET` is trimmed of before it is compared; td-scorer.yml's publish
# job normalises it the same way in shell.
SWITCH_WHITESPACE = " \t\n\r\x0b\x0c"


def round_sig(value: float) -> float:
    """Rounded to SIG_DIGITS significant digits: GitHub push protection blocks the long
    digit runs of full-precision floats on generated-stats."""
    return float(f"{float(value):.{SIG_DIGITS}g}")


def round_table(
    x: Sequence[float], y: Sequence[float]
) -> tuple[list[float], list[float]]:
    """A breakpoint table rounded, keeping x strictly increasing: points whose rounded x
    collide merge into one, with the larger (later) y, so y stays non-decreasing."""
    xs: list[float] = []
    ys: list[float] = []
    for xi, yi in zip(x, y):
        rx = round_sig(xi)
        ry = min(Y_MAX, max(Y_MIN, round_sig(yi)))
        if xs and rx <= xs[-1]:
            ys[-1] = max(ys[-1], ry)
            continue
        xs.append(rx)
        ys.append(ry)
    return xs, ys


def valid_name(name: str) -> bool:
    return isinstance(name, str) and 0 < len(name) <= MAX_NAME


def without_budget(model: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in model.items() if k != "budget"}


def budget_on(value: Optional[str]) -> bool:
    """Whether the `TD_SCORER_BUDGET` repository variable switches the budget on: exactly
    "on" once trimmed of whitespace and lowercased."""
    return (value or "").strip(SWITCH_WHITESPACE).lower() == "on"


def valid_budget(budget: Mapping[str, Any]) -> bool:
    """Whether pytorch's validator accepts the block."""
    if set(budget) != set(BUDGET_KEYS):
        return False
    values = [budget[key] for key in BUDGET_KEYS]
    if not all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        for v in values
    ):
        return False
    s, k, a = (float(v) for v in values)
    return 0 <= k < 1 and 0 <= a <= 1 and MIN_SHARE <= s * (1 - k) and s <= MAX_SHARE


def clamped_risk(risk: Any) -> Optional[float]:
    if isinstance(risk, bool) or not isinstance(risk, (int, float)):
        return None
    try:
        r = float(risk)
    except OverflowError:
        return None
    if not math.isfinite(r):
        return None
    return max(-1.0, min(1.0, r))


def budget_share(
    model: Mapping[str, Any], build_files: Any, risk: Any
) -> tuple[Optional[float], str]:
    """(share of the job's total cost, mode); share None (no block) keeps TD's cost. A
    change touching build paths, or whose build-path count or r is unknown, gets the top
    of the window, s * (1 + k)."""
    if "budget" not in model:
        return None, "none"
    budget = model["budget"]
    s, k = budget["share"], budget["spread"]
    top = max(MIN_SHARE, min(MAX_SHARE, s * (1 + k)))
    if isinstance(build_files, bool) or not isinstance(build_files, int):
        return top, "build_paths"
    if build_files > 0:
        return top, "build_paths"
    r = clamped_risk(risk)
    if r is None:
        return top, "unknown_risk"
    share = s * (1 + k * r)
    return max(MIN_SHARE, min(MAX_SHARE, share)), "share"


def build_model(
    version: str,
    scorer: Mapping[str, Any],
    risk: Mapping[str, Any],
    start_up_seconds: Mapping[str, Mapping[str, float]],
    enabled: bool = True,
    budget: Optional[Mapping[str, float]] = None,
) -> dict[str, Any]:
    """The model file; `start_up_seconds` is start_up.table's, already rounded and
    filtered."""
    heuristics = {}
    for name, h in scorer["heuristics"].items():
        x, y = round_table(h["x"], h["y"])
        heuristics[name] = {"weight": max(0.0, round_sig(h["weight"])), "x": x, "y": y}
    model: dict[str, Any] = {
        "schema": SCHEMA,
        "version": version,
        "enabled": enabled,
        "start_up_seconds": {
            env: dict(configs) for env, configs in start_up_seconds.items()
        },
        "scorer": {
            "intercept": round_sig(scorer["intercept"]),
            "cost_weight": round_sig(scorer["cost_weight"]),
            "heuristics": heuristics,
            "build_env": {k: round_sig(v) for k, v in scorer["build_env"].items()},
            "test_config": {k: round_sig(v) for k, v in scorer["test_config"].items()},
        },
        "risk": {
            "intercept": round_sig(risk["intercept"]),
            "features": {
                k: {
                    "weight": round_sig(f["weight"]),
                    "mean": round_sig(f["mean"]),
                    "scale": round_sig(f["scale"]),
                }
                for k, f in risk["features"].items()
            },
            "quantiles": [round_sig(q) for q in risk["quantiles"]],
        },
    }
    if budget is not None:
        model["budget"] = {k: round_sig(budget[k]) for k in BUDGET_KEYS}
    return model


def dumps(model: Mapping[str, Any]) -> str:
    return (
        json.dumps(model, sort_keys=True, allow_nan=False, separators=(",", ":")) + "\n"
    )


def calibrated_log_odds(table: Mapping[str, Any], scores: np.ndarray) -> np.ndarray:
    """ln(c / (1 - c)) with c the table's piecewise-linear value, clamped at both ends."""
    c = np.interp(scores, table["x"], table["y"])
    return np.log(c / (1 - c))  # type: ignore[no-any-return]


def scorer_z(
    model: Mapping[str, Any],
    scores: Mapping[str, Mapping[str, float]],
    raised: Optional[set[str]],
    build_env: str,
    test_config: str,
    files: Sequence[str],
    costs: np.ndarray,
) -> np.ndarray:
    """The scorer's log-odds for each file of one job (contract section 2)."""
    s = model["scorer"]
    z = (
        s["intercept"]
        + s["cost_weight"] * np.log(costs)
        + s["build_env"].get(build_env, 0.0)
        + s["test_config"].get(test_config, 0.0)
    )
    for name, table in s["heuristics"].items():
        if raised and name in raised:
            continue
        per_file = scores.get(name, {})
        values = np.array([per_file.get(f, 0.0) for f in files], dtype=float)
        z = z + table["weight"] * calibrated_log_odds(table, values)
    return np.asarray(z, dtype=float)


def p_files(
    model: Mapping[str, Any],
    scores: Mapping[str, Mapping[str, float]],
    raised: Optional[set[str]],
    build_env: str,
    test_config: str,
    files: Sequence[str],
    costs: np.ndarray,
) -> np.ndarray:
    z = scorer_z(model, scores, raised, build_env, test_config, files, costs)
    return np.exp(-np.logaddexp(0.0, -z))  # type: ignore[no-any-return]
