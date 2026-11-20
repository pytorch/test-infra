"""The per-change risk score: how likely a PR head is to break something TD-on jobs catch.

Features come from the head's changed files (contract section 5), each as ln(1 + v),
standardised. The target is the head having at least one counted positive in a TD-on job;
each counted trunk landing adds its PR heads as positives weighing W_TRUNK in all. A
weighted logistic regression gives raw risk, and r = 2F - 1 with F the position of raw in
the 101-point quantile table of the training heads' raw risk.
"""

import math
import os
from bisect import bisect_right
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional, Sequence

import numpy as np
from torchci.td.scorer.logs import TDLog
from torchci.td.scorer.rows import unit_labels, W_TRUNK
from torchci.td.scorer.shards import DayShard
from torchci.td.scorer.train import Design, fit_logistic
from torchci.td.scorer.trunk import counted_pairs, TrunkLanding


FEATURES = ("n_files", "n_test_files", "n_source_files", "n_areas", "docs_only")
# pytorch's is_docs_only_change rule (target_determination/heuristics/utils.py), which
# pytorch's scorer_model.py mirrors: the risk features must match on both sides.
DOC_SUFFIXES = (".md", ".rst")
NON_SOURCE_DIRS = ("test/", "docs/", "third_party/")
QUANTILES = 101
# The paths that give a change the top of the budget window; pytorch's scorer_paths.py
# holds the same lists and check-pytorch compares them.
MAX_CHANGED_FILES = 3000
BUILD_DIRS = (
    "third_party/",
    "cmake/",
    ".ci/",
    ".github/",
    "torchgen/",
    "tools/setup_helpers/",
    "tools/autograd/",
    "tools/testing/",
    "tools/stats/",
    "torch/testing/_internal/",
    "test/dynamo_expected_failures/",
    "test/dynamo_skips/",
    "test/inductor_expected_failures/",
    "test/inductor_skips/",
    "aten/src/ATen/templates/",
    "tools/jit/",
    "tools/pyi/",
    "tools/amd_build/",
)
BUILD_FILES = ("test/run_test.py",)
BUILD_BASENAMES = (
    "CMakeLists.txt",
    "setup.py",
    "setup.cfg",
    "pyproject.toml",
    "version.txt",
    "BUILD.bazel",
    "BUILD",
    "WORKSPACE",
    "conftest.py",
    "pytest.ini",
    "native_functions.yaml",
    "tags.yaml",
    "MODULE.bazel",
    ".bazelrc",
    ".bazelversion",
)
BUILD_BASENAME_PREFIXES = ("requirements",)
BUILD_SUFFIXES = (".cmake", ".bzl")
BUILD_PATH_CONSTANTS = (
    "MAX_CHANGED_FILES",
    "BUILD_DIRS",
    "BUILD_FILES",
    "BUILD_BASENAMES",
    "BUILD_BASENAME_PREFIXES",
    "BUILD_SUFFIXES",
)


def is_docs(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in DOC_SUFFIXES


def change_features(paths: Sequence[str]) -> dict[str, int]:
    """Empty paths (an empty diff's [""]) are dropped first."""
    paths = [p for p in paths if p]
    return {
        "n_files": len(paths),
        "n_test_files": sum(p.startswith("test/") for p in paths),
        "n_source_files": sum(
            not p.startswith(NON_SOURCE_DIRS) and not is_docs(p) for p in paths
        ),
        "n_areas": len({p.split("/", 1)[0] for p in paths}),
        "docs_only": int(bool(paths) and all(is_docs(p) for p in paths)),
    }


def is_build_path(path: str) -> bool:
    base = path.rsplit("/", 1)[-1]
    return (
        path.startswith(BUILD_DIRS)
        or path in BUILD_FILES
        or base in BUILD_BASENAMES
        or (base.startswith(BUILD_BASENAME_PREFIXES) and base.endswith(".txt"))
        or base.endswith(BUILD_SUFFIXES)
    )


def count_build_files(paths: Sequence[str]) -> Optional[int]:
    """How many of a change's paths are build paths, empty paths dropped; None when no
    path is left, and every path when the list has MAX_CHANGED_FILES or more, since
    GitHub truncates the list there."""
    paths = [p for p in paths if p]
    if not paths:
        return None
    if len(paths) >= MAX_CHANGED_FILES:
        return len(paths)
    return sum(is_build_path(p) for p in paths)


def risk_raw(model: Mapping[str, Any], features: Mapping[str, int]) -> float:
    risk = model["risk"]
    raw = risk["intercept"]
    for name, f in risk["features"].items():
        raw += f["weight"] * (math.log(1 + features[name]) - f["mean"]) / f["scale"]
    return float(raw)


def risk_r(model: Mapping[str, Any], features: Mapping[str, int]) -> float:
    raw, q = risk_raw(model, features), model["risk"]["quantiles"]
    if raw < q[0]:
        frac = 0.0
    elif raw >= q[-1]:
        frac = 1.0
    else:
        i = bisect_right(q, raw) - 1
        frac = (i + (raw - q[i]) / (q[i + 1] - q[i])) / (QUANTILES - 1)
    return 2 * min(max(frac, 0.0), 1.0) - 1


@dataclass
class Head:
    pr: int
    head_sha: str
    files: list[str]
    positive: bool


def collect_heads(
    shard: DayShard, heads: dict[str, Head], exclude_prs: set[int]
) -> None:
    """Adds the shard's PR heads (with changed files) to `heads`, keyed by sha."""
    positive_runs = {u.run_id for u in shard.units if unit_labels(u)[0]}
    for run in shard.runs:
        if run.pr in exclude_prs or run.changed_files is None:
            continue
        head = heads.setdefault(
            run.head_sha,
            Head(run.pr, run.head_sha, list(run.changed_files), False),
        )
        head.positive = head.positive or run.run_id in positive_runs


def trunk_heads(
    landings: Iterable[TrunkLanding], logs: Mapping[str, TDLog], exclude_prs: set[int]
) -> list[tuple[list[str], float]]:
    """(changed files, weight) per distinct PR head of each counted landing."""
    out = []
    for landing in landings:
        shas = sorted(
            {
                p.head_sha
                for p in counted_pairs(landing, logs, exclude_prs)
                if logs[p.head_sha].changed_files is not None
            }
        )
        for sha in shas:
            out.append((list(logs[sha].changed_files or ()), W_TRUNK / len(shas)))
    return out


def _matrix(files: Iterable[Sequence[str]]) -> np.ndarray:
    rows = [[math.log(1 + change_features(f)[k]) for k in FEATURES] for f in files]
    return np.array(rows, dtype=float).reshape(-1, len(FEATURES))


def fit_risk(
    heads: Sequence[Head], trunk: Sequence[tuple[list[str], float]]
) -> dict[str, Any]:
    """The `risk` block of the model file."""
    if not heads:
        raise ValueError("no PR heads to fit the risk score on")
    x = _matrix([h.files for h in heads])
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale = np.where(scale > 1e-9, scale, 1.0)
    xt = _matrix([files for files, _ in trunk])
    std = (np.vstack([x, xt]) - mean) / scale
    y = np.concatenate([[float(h.positive) for h in heads], np.ones(len(trunk))])
    w = np.concatenate([np.ones(len(heads)), [wt for _, wt in trunk]])
    n = len(y)
    zeros = np.zeros(n, dtype=np.int64)
    design = Design(np.column_stack([np.ones(n), std]), zeros, 0, zeros, 0)
    k = 1 + len(FEATURES)
    penalty = np.zeros(design.size)
    penalty[1:k] = 1.0
    fixed = np.zeros(design.size, dtype=bool)
    fixed[k:] = True
    beta = fit_logistic(
        design,
        y,
        w,
        np.zeros(design.size, dtype=bool),
        penalty,
        fixed,
        np.zeros(design.size),
    )
    raw = beta[0] + ((x - mean) / scale) @ beta[1:k]
    return {
        "intercept": float(beta[0]),
        "features": {
            name: {
                "weight": float(beta[1 + i]),
                "mean": float(mean[i]),
                "scale": float(scale[i]),
            }
            for i, name in enumerate(FEATURES)
        },
        "quantiles": np.quantile(raw, np.linspace(0, 1, QUANTILES)).tolist(),
    }


def weighted_auc(
    score: np.ndarray, label: np.ndarray, weight: Optional[np.ndarray] = None
) -> float:
    """Area under the ROC curve, ties counted half; nan without both classes."""
    weight = np.ones(len(score)) if weight is None else weight
    pos = weight * (label == 1)
    neg = weight * (label == 0)
    if pos.sum() == 0 or neg.sum() == 0:
        return float("nan")
    uniq, inv = np.unique(score, return_inverse=True)
    pos_at = np.bincount(inv, weights=pos, minlength=len(uniq))
    neg_at = np.bincount(inv, weights=neg, minlength=len(uniq))
    neg_below = np.cumsum(neg_at) - neg_at
    return float(np.sum(pos_at * (neg_below + 0.5 * neg_at)) / (pos.sum() * neg.sum()))


def labelled(
    model: Mapping[str, Any], heads: Sequence[Head], trunk_shas: set[str]
) -> tuple[np.ndarray, np.ndarray]:
    """r per head, and its label: a counted positive or a counted trunk landing's head."""
    r = np.array([risk_r(model, change_features(h.files)) for h in heads], dtype=float)
    label = np.array([h.positive or h.head_sha in trunk_shas for h in heads], dtype=int)
    return r, label


def evaluate(r: np.ndarray, label: np.ndarray) -> dict[str, float]:
    """AUC and mean of r over heads `labelled` scored."""
    if not len(r):
        return {"heads": 0, "auc": float("nan"), "mean_r": float("nan")}
    return {
        "heads": len(r),
        "positive_heads": int(label.sum()),
        "auc": weighted_auc(r, label),
        "mean_r": float(r.mean()),
    }
