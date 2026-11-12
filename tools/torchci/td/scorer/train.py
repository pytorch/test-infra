"""The calibrated scorer: a per-heuristic isotonic calibration, then non-negative weights.

1. Per heuristic, weighted pool-adjacent-violators maps its score to the chance the file
   fails, fitted on the rows where it ran and did not raise; the table starts at 0.0 and
   is clipped to [Y_MIN, Y_MAX].
2. A weighted logistic regression over each heuristic's calibrated log-odds (0 where it
   raised), one-hots of the build env and test config (L2-penalised) and ln(cost), with
   the heuristic weights held >= 0 by projected Newton steps.
"""

from datetime import date, timedelta
from typing import Any, Optional

import numpy as np
from torchci.td.scorer.model_json import (
    calibrated_log_odds,
    MAX_BUILD_ENVS,
    MAX_POINTS,
    MAX_TEST_CONFIGS,
    round_table,
    valid_name,
    Y_MAX,
    Y_MIN,
)
from torchci.td.scorer.rows import Rows
from torchci.td.scorer.shards import FIRST_DATA_DAY


GATE_DAYS = 14
# A refit reads the last year of days: the shipped model is fitted on them and the
# walk-forward months fall in them, so older pytorch behaviour ages out.
WINDOW_DAYS = 365
L2 = 10.0
# TD logs come from the PR's own code, so a heuristic name in one proves nothing: only
# TD's own heuristics (pytorch's target_determination HEURISTICS) enter the model. Those
# in trial mode there are left out: trial mode promises their scores never reorder tests.
HEURISTICS = (
    "PreviouslyFailedInPR",
    "EditedByPR",
    "MentionedInPR",
    "CorrelatedWithHistoricalFailures",
    "HistorialEditedFiles",
    "Profiling",
    "LLM",
    "Filepath",
    "PublicBindings",
)
MAX_ITER = 50
TOL = 1e-9


def training_days(
    refit_day: date, train: Optional[int] = None, gate: int = GATE_DAYS
) -> list[date]:
    """The last `train` days (WINDOW_DAYS - `gate` by default, so that with the gate days
    they make WINDOW_DAYS), from FIRST_DATA_DAY at the earliest, to the day `gate` + 1
    days before the refit day."""
    end = refit_day - timedelta(days=gate)
    first = end - timedelta(days=WINDOW_DAYS - gate if train is None else train)
    first = max(first, FIRST_DATA_DAY)
    return [first + timedelta(days=i) for i in range((end - first).days)]


def gate_days(refit_day: date, gate: int = GATE_DAYS) -> list[date]:
    return [refit_day - timedelta(days=i) for i in range(gate, 0, -1)]


def pav(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Weighted non-decreasing least-squares fit of y (already ordered by x)."""
    means: list[float] = []
    weights: list[float] = []
    counts: list[int] = []
    for yi, wi in zip(y.tolist(), w.tolist()):
        means.append(yi)
        weights.append(wi)
        counts.append(1)
        while len(means) > 1 and means[-2] > means[-1]:
            wsum = weights[-2] + weights[-1]
            means[-2] = (means[-2] * weights[-2] + means[-1] * weights[-1]) / wsum
            weights[-2] = wsum
            counts[-2] += counts[-1]
            del means[-1], weights[-1], counts[-1]
    return np.repeat(means, counts)


def isotonic_table(
    scores: np.ndarray, labels: np.ndarray, weights: np.ndarray
) -> tuple[list[float], list[float]]:
    """The calibration table of one heuristic: x strictly increasing from 0.0, at most
    MAX_POINTS points, y non-decreasing in [Y_MIN, Y_MAX], rounded as exported."""
    x = np.maximum(scores, 0.0)
    keep = weights > 0
    x, labels, weights = x[keep], labels[keep].astype(float), weights[keep]
    if not len(x):
        return [0.0], [Y_MIN]
    ux, inv = np.unique(x, return_inverse=True)
    wsum = np.bincount(inv, weights=weights)
    ysum = np.bincount(inv, weights=weights * labels)
    xsum = ux * wsum
    groups = len(ux) - (1 if ux[0] == 0 else 0)
    if groups > MAX_POINTS - 2:
        start = 1 if ux[0] == 0 else 0
        cum = np.cumsum(wsum[start:])
        bins = np.minimum(
            (cum / cum[-1] * (MAX_POINTS - 2)).astype(int), MAX_POINTS - 3
        )
        group = np.concatenate([np.zeros(start, dtype=int), bins + start])
        _, group = np.unique(group, return_inverse=True)
        wsum, ysum, xsum = (np.bincount(group, weights=v) for v in (wsum, ysum, xsum))
        gx = xsum / wsum
        if start:
            gx[0] = 0.0
        ux = gx
    fitted = pav(ysum / wsum, wsum)
    keep = np.ones(len(ux), dtype=bool)
    keep[1:-1] = ~((fitted[1:-1] == fitted[:-2]) & (fitted[1:-1] == fitted[2:]))
    xs, ys = ux[keep].tolist(), np.clip(fitted[keep], Y_MIN, Y_MAX).tolist()
    if xs[0] > 0:
        xs, ys = [0.0] + xs, [ys[0]] + ys
    return round_table(xs, ys)


def _onehot(
    codes: np.ndarray, names: list[str], weight: np.ndarray, limit: int
) -> tuple[np.ndarray, list[str]]:
    """Codes into kept names (valid, at most `limit`, by weight), the rest into an extra
    last column whose coefficient stays 0."""
    total = np.bincount(codes, weights=weight, minlength=len(names))
    order = [i for i in np.argsort(-total, kind="stable") if valid_name(names[i])]
    kept = sorted(order[:limit], key=lambda i: names[i])
    remap = np.full(len(names), len(kept), dtype=np.int64)
    remap[kept] = np.arange(len(kept))
    return remap[codes], [names[i] for i in kept]


class Design:
    """[dense | build env one-hot | test config one-hot] without materialising the
    one-hots: products go through bincount."""

    def __init__(
        self,
        dense: np.ndarray,
        env: np.ndarray,
        n_env: int,
        cfg: np.ndarray,
        n_cfg: int,
    ):
        self.dense, self.env, self.cfg = dense, env, cfg
        self.k, self.n_env, self.n_cfg = dense.shape[1], n_env + 1, n_cfg + 1
        self.size = self.k + self.n_env + self.n_cfg

    def z(self, beta: np.ndarray) -> np.ndarray:
        k, e = self.k, self.k + self.n_env
        return self.dense @ beta[:k] + beta[k:e][self.env] + beta[e:][self.cfg]

    def xtv(self, v: np.ndarray) -> np.ndarray:
        return np.concatenate(
            [
                self.dense.T @ v,
                np.bincount(self.env, weights=v, minlength=self.n_env),
                np.bincount(self.cfg, weights=v, minlength=self.n_cfg),
            ]
        )

    def xtvx(self, v: np.ndarray) -> np.ndarray:
        k, e = self.k, self.k + self.n_env
        h = np.zeros((self.size, self.size))
        h[:k, :k] = (self.dense * v[:, None]).T @ self.dense
        for j in range(k):
            dv = self.dense[:, j] * v
            h[j, k:e] = np.bincount(self.env, weights=dv, minlength=self.n_env)
            h[j, e:] = np.bincount(self.cfg, weights=dv, minlength=self.n_cfg)
        h[k:e, k:e] = np.diag(np.bincount(self.env, weights=v, minlength=self.n_env))
        h[e:, e:] = np.diag(np.bincount(self.cfg, weights=v, minlength=self.n_cfg))
        cross = np.bincount(
            self.env * self.n_cfg + self.cfg,
            weights=v,
            minlength=self.n_env * self.n_cfg,
        )
        h[k:e, e:] = cross.reshape(self.n_env, self.n_cfg)
        return np.triu(h) + np.triu(h, 1).T


def fit_logistic(
    design: Design,
    y: np.ndarray,
    w: np.ndarray,
    nonneg: np.ndarray,
    penalty: np.ndarray,
    fixed: np.ndarray,
    beta0: np.ndarray,
) -> np.ndarray:
    """Minimises the weighted log loss plus L2/2 * sum(penalty * beta^2) with beta >= 0
    where `nonneg` and beta == 0 where `fixed`: projected Newton with an Armijo search."""

    def loss(beta: np.ndarray) -> float:
        z = design.z(beta)
        data = float(np.sum(w * (np.logaddexp(0.0, z) - y * z)))
        return data + 0.5 * L2 * float(np.sum(penalty * beta**2))

    beta = np.where(fixed, 0.0, beta0)
    current = loss(beta)
    for _ in range(MAX_ITER):
        z = design.z(beta)
        p = np.exp(-np.logaddexp(0.0, -z))
        grad = design.xtv(w * (p - y)) + L2 * penalty * beta
        hess = design.xtvx(w * p * (1 - p)) + L2 * np.diag(penalty)
        bound = fixed | (nonneg & (beta <= 0) & (grad > 0))
        free = ~bound
        step = np.zeros_like(beta)
        sub = hess[np.ix_(free, free)] + 1e-10 * np.eye(int(free.sum()))
        step[free] = -np.linalg.solve(sub, grad[free])
        t, improved = 1.0, False
        for _ in range(40):
            cand = beta + t * step
            cand[nonneg] = np.maximum(cand[nonneg], 0.0)
            cand[fixed] = 0.0
            value = loss(cand)
            if value <= current + 1e-4 * float(grad @ (cand - beta)):
                improved = True
                break
            t /= 2
        if not improved:
            break
        change = float(np.max(np.abs(cand - beta)))
        beta, previous, current = cand, current, value
        if change < TOL or previous - current < TOL * max(1.0, abs(current)):
            break
    return beta


def fit_scorer(rows: Rows) -> dict[str, Any]:
    """The `scorer` block of the model file, unrounded except for the tables."""
    if not len(rows) or not rows.label.any():
        raise ValueError("no positive training rows")
    w, y = rows.weight, rows.label.astype(float)
    names = sorted(h for h in rows.heuristics if h in HEURISTICS)
    tables, columns = {}, []
    for h in names:
        j = rows.heuristics.index(h)
        act = rows.active[:, j]
        x, yy = isotonic_table(rows.scores[act, j], rows.label[act], w[act])
        tables[h] = {"x": x, "y": yy}
        col = np.zeros(len(rows))
        col[act] = calibrated_log_odds(tables[h], np.maximum(rows.scores[act, j], 0.0))
        columns.append(col)
    dense = np.column_stack([np.ones(len(rows)), np.log(rows.cost)] + columns)
    env, envs = _onehot(rows.env, rows.build_envs, w, MAX_BUILD_ENVS)
    cfg, cfgs = _onehot(rows.config, rows.test_configs, w, MAX_TEST_CONFIGS)
    design = Design(dense, env, len(envs), cfg, len(cfgs))
    k = dense.shape[1]
    nonneg = np.zeros(design.size, dtype=bool)
    nonneg[2:k] = True
    penalty = np.zeros(design.size)
    penalty[k:] = 1.0
    fixed = np.zeros(design.size, dtype=bool)
    fixed[k + design.n_env - 1] = fixed[-1] = True
    beta0 = np.zeros(design.size)
    rate = float(np.clip(np.sum(w * y) / np.sum(w), Y_MIN, Y_MAX))
    beta0[0] = np.log(rate / (1 - rate))
    beta = fit_logistic(design, y, w, nonneg, penalty, fixed, beta0)
    e = k + design.n_env
    return {
        "intercept": float(beta[0]),
        "cost_weight": float(beta[1]),
        "heuristics": {
            h: {"weight": float(beta[2 + i]), **tables[h]} for i, h in enumerate(names)
        },
        "build_env": {n: float(b) for n, b in zip(envs, beta[k : e - 1])},
        "test_config": {n: float(b) for n, b in zip(cfgs, beta[e:-1])},
    }
