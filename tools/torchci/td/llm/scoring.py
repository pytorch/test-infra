"""Scores of test files for a PR from query and unit embeddings, and the output mapping."""

import math
from typing import Mapping, Sequence

import numpy as np


AGGREGATIONS = ("max", "mean")
TRANSFORMS = ("raw", "top_quarter", "rank")
AGGREGATION = "max"
TRANSFORM = "rank"
# TD runs the top quarter of a job's ranked tests (pytorch test/run_test.py,
# percent_to_run = 25).
TD_CUT_FRACTION = 0.25


def file_scores(
    query: np.ndarray, units: np.ndarray, unit_tests: Sequence[str], agg: str
) -> dict[str, float]:
    """Per test file: its best unit's cosine for each query row, then `agg` over rows.

    Both matrices hold L2-normalized rows, so the dot product is the cosine.
    """
    if agg not in AGGREGATIONS:
        raise ValueError(f"unknown aggregation: {agg}")
    query = np.asarray(query, dtype=np.float32)
    units = np.asarray(units, dtype=np.float32)
    if units.shape[0] != len(unit_tests):
        raise ValueError(f"{units.shape[0]} unit rows for {len(unit_tests)} tests")
    if query.shape[0] == 0 or units.shape[0] == 0:
        return {}
    names, inverse = np.unique(np.asarray(unit_tests, dtype=str), return_inverse=True)
    order = np.argsort(inverse, kind="stable")
    starts = np.flatnonzero(np.r_[True, np.diff(inverse[order]) != 0])
    best = np.maximum.reduceat((query @ units.T)[:, order], starts, axis=1)
    combined = best.max(axis=0) if agg == "max" else best.mean(axis=0)
    return {name: float(value) for name, value in zip(names.tolist(), combined)}


def transform(scores: Mapping[str, float], kind: str) -> dict[str, float]:
    """`raw`: the scores > 0. `top_quarter`: the excess over the 75th percentile, where
    positive. `rank`: 1 - r / K for the K = ceil(25%) best files, r = 0..K-1."""
    if kind not in TRANSFORMS:
        raise ValueError(f"unknown transform: {kind}")
    finite = {k: v for k, v in scores.items() if math.isfinite(v)}
    if kind == "raw":
        return {k: v for k, v in finite.items() if v > 0}
    if not finite:
        return {}
    if kind == "top_quarter":
        values = np.fromiter(finite.values(), dtype=np.float64)
        cut = float(np.quantile(values, 1 - TD_CUT_FRACTION))
        return {k: v - cut for k, v in finite.items() if v - cut > 0}
    top = math.ceil(TD_CUT_FRACTION * len(finite))
    ranked = sorted(finite.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
    return {k: 1 - r / top for r, (k, _) in enumerate(ranked)}


def to_mapping(scores: Mapping[str, float]) -> dict[str, float]:
    """The file pytorch's llm.py reads: `<test>.py` -> score, finite scores > 0 only."""
    return {
        f"{test}.py": float(score)
        for test, score in sorted(scores.items())
        if math.isfinite(score) and score > 0
    }
