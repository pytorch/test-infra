"""The model file `td-scorer.json` (schema 1) and the scorer's p, as pytorch evaluates them.

pytorch's `tools/testing/target_determination/scorer.py` is the runtime definition of the
format and of p; this module writes that format and evaluates p the same way, so the gate
measures the file that ships.
"""

import json
from typing import Any, Mapping, Optional, Sequence

import numpy as np
from torchci.td.scorer.rows import OVERHEAD_SECONDS
from torchci.td.scorer.store import SIG_DIGITS


SCHEMA = 1
Y_MIN, Y_MAX = 1e-6, 1 - 1e-6
MAX_POINTS = 512
MAX_BUILD_ENVS = 2000
MAX_TEST_CONFIGS = 500
MAX_NAME = 200


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


def build_model(
    version: str,
    scorer: Mapping[str, Any],
    risk: Mapping[str, Any],
    enabled: bool = True,
    overhead_seconds: float = OVERHEAD_SECONDS,
) -> dict[str, Any]:
    heuristics = {}
    for name, h in scorer["heuristics"].items():
        x, y = round_table(h["x"], h["y"])
        heuristics[name] = {"weight": max(0.0, round_sig(h["weight"])), "x": x, "y": y}
    return {
        "schema": SCHEMA,
        "version": version,
        "enabled": enabled,
        "overhead_seconds": round_sig(overhead_seconds),
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
