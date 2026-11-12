"""Per-config start-up seconds k, fitted on the test shards of the days before a refit.

Per successful test job (one shard) of a TD workflow on a TD platform: y is its "Test"
step seconds, s the sum of its test-case seconds (the measure test-times.json averages),
n the distinct test files it ran. Per (build env, test config), y ~ c + a*s + b*n is
fitted by least squares, with one pass that drops residuals beyond TRIM_MADS robust
standard deviations, and k = b / a: the start-up of one file in test-case seconds. The
cut only depends on k, because the budget is TD's own cut costed the same way, so a
scales both sides. A bootstrap over runs gives k's 90% interval. Only accepted fits
enter the table; a config without one keeps TD's cut.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable, Mapping, Optional

import numpy as np
from torchci.td.llm.events_sql import TD_SCOPE
from torchci.td.scorer import shards
from torchci.td.scorer.model_json import (
    MAX_BUILD_ENVS,
    MAX_START_UP_SECONDS,
    MAX_TEST_CONFIGS,
    MIN_START_UP_SECONDS,
    round_sig,
    valid_name,
)
from torchci.td.scorer.rows_sql import IS_FILE, JOB_COLUMNS, SETTINGS


DAYS = 7
MAX_SHARD_SECONDS = 4 * 3600
MAX_SHARD_FILES = 2000
MAX_SECONDS_RATIO = 16
MIN_SHARDS = 300
MIN_RUNS = 30
MIN_A = 0.1
TRIM_MADS = 5
BOOTSTRAPS = 60
SEED = 0
MIN_FINITE = 0.95
MAX_WIDTH_RATIO = 0.5
MIN_MAX_WIDTH = 4.0

# The latest row of each job (ORDER BY _inserted_at DESC LIMIT 1 BY id) is filtered after
# the dedupe, so an earlier row's conclusion never decides. Counts come back as Float64:
# JSONEachRow quotes 64-bit integers.
SQL = f"""
WITH
    jobs AS (
        SELECT id, run_id, build_env, test_config, y
        FROM (
            SELECT id, run_id, workflow_name AS workflow, status, conclusion,
                {JOB_COLUMNS},
                arrayFilter(x -> tupleElement(x, 'name') = 'Test', steps) AS test_steps,
                dateDiff(
                    'second',
                    tupleElement(test_steps[1], 'started_at'),
                    tupleElement(test_steps[1], 'completed_at')
                ) AS y
            FROM default.workflow_job
            PREWHERE id IN (
                SELECT id FROM materialized_views.workflow_job_by_created_at
                WHERE created_at >= {{start: DateTime64(3)}}
                    AND created_at < {{stop: DateTime64(3)}}
            )
            WHERE length(np) = 2 AND startsWith(dynamoKey, 'pytorch/pytorch/')
            ORDER BY _inserted_at DESC
            LIMIT 1 BY id
        )
        WHERE status = 'completed' AND conclusion = 'success' AND {TD_SCOPE}
            AND length(test_steps) = 1
    )
SELECT j.build_env AS build_env, j.test_config AS test_config, j.run_id AS run_id,
    toFloat64(j.y) AS y, toFloat64(sum(t.time)) AS s,
    toFloat64(uniqExact(t.invoking_file)) AS n
FROM tests.all_test_runs AS t
INNER JOIN jobs AS j ON j.id = t.job_id AND j.run_id = t.workflow_id
WHERE t.job_id IN (SELECT id FROM jobs) AND {IS_FILE}
GROUP BY j.build_env, j.test_config, j.run_id, j.id, j.y
{SETTINGS}
"""


def fetch(day: date) -> list[dict[str, Any]]:
    """The shards of the DAYS days before `day`, one query per day."""
    out: list[dict[str, Any]] = []
    for i in range(DAYS, 0, -1):
        d = day - timedelta(days=i)
        out.extend(shards.query("td_scorer_start_up", SQL, shards.ch_day(d)))
    return out


def in_bounds(y: float, s: float, n: float) -> bool:
    return (
        0 < y <= MAX_SHARD_SECONDS
        and 1 <= n <= MAX_SHARD_FILES
        and 0 <= s <= MAX_SECONDS_RATIO * y
    )


def group(rows: Iterable[Mapping[str, Any]]) -> dict[tuple[str, str], np.ndarray]:
    """Per (build env, test config) of a TD platform, its in-bounds shards as rows of
    (run, y, s, n)."""
    by: dict[tuple[str, str], list[tuple[float, float, float, float]]] = {}
    for r in rows:
        env, config = r["build_env"], r["test_config"]
        y, s, n = float(r["y"]), float(r["s"]), float(r["n"])
        if not shards.td_platform(env) or not in_bounds(y, s, n):
            continue
        by.setdefault((env, config), []).append((float(r["run_id"]), y, s, n))
    return {key: np.array(v, dtype=float) for key, v in by.items()}


def ols(data: np.ndarray) -> Optional[np.ndarray]:
    """(c, a, b) of y ~ c + a*s + b*n, or None when s and n cannot both be told apart
    from the intercept."""
    if len(data) < 3 or len(np.unique(data[:, 3])) < 3:
        return None
    x = np.column_stack([np.ones(len(data)), data[:, 2], data[:, 3]])
    if np.linalg.matrix_rank(x) < 3:
        return None
    beta, *_ = np.linalg.lstsq(x, data[:, 1], rcond=None)
    return beta  # type: ignore[no-any-return]


def trimmed_fit(data: np.ndarray) -> Optional[np.ndarray]:
    beta = ols(data)
    if beta is None:
        return None
    x = np.column_stack([np.ones(len(data)), data[:, 2], data[:, 3]])
    res = data[:, 1] - x @ beta
    mad = float(np.median(np.abs(res - np.median(res))))
    if mad == 0:
        return beta
    return ols(data[np.abs(res) <= TRIM_MADS * 1.4826 * mad])


def k_of(beta: Optional[np.ndarray]) -> float:
    if beta is None or not beta[1] > 0:
        return float("nan")
    return float(beta[2] / beta[1])


@dataclass
class ConfigFit:
    build_env: str
    test_config: str
    shards: int
    runs: int
    c: float = float("nan")
    a: float = float("nan")
    k: float = float("nan")
    lo: float = float("nan")
    hi: float = float("nan")
    finite: float = 0.0

    def checks(self) -> list[tuple[bool, str]]:
        width = max(MAX_WIDTH_RATIO * self.k, MIN_MAX_WIDTH)
        return [
            (
                self.shards >= MIN_SHARDS and self.runs >= MIN_RUNS,
                "too few shards or runs",
            ),
            (np.isfinite(self.a), "no fit: n or s does not vary enough"),
            (self.a >= MIN_A, f"a not >= {MIN_A}"),
            (
                MIN_START_UP_SECONDS <= self.k <= MAX_START_UP_SECONDS,
                f"k not in [{MIN_START_UP_SECONDS:g}, {MAX_START_UP_SECONDS:g}]",
            ),
            (self.finite >= MIN_FINITE, "bootstrap fits not finite"),
            (self.hi - self.lo <= width, "90% interval too wide"),
        ]

    @property
    def accepted(self) -> bool:
        """Every check holds; a NaN fails every comparison it is in."""
        return all(ok for ok, _ in self.checks())

    @property
    def reason(self) -> str:
        return next((why for ok, why in self.checks() if not ok), "")


def fit_config(env: str, config: str, data: np.ndarray) -> ConfigFit:
    runs, run_of = np.unique(data[:, 0], return_inverse=True)
    fit = ConfigFit(env, config, len(data), len(runs))
    if fit.shards < MIN_SHARDS or fit.runs < MIN_RUNS:
        return fit
    beta = trimmed_fit(data)
    if beta is not None:
        fit.c, fit.a = float(beta[0]), float(beta[1])
    fit.k = k_of(beta)
    rng = np.random.default_rng(SEED)
    order = np.argsort(run_of, kind="stable")
    by_run = np.split(order, np.cumsum(np.bincount(run_of))[:-1])
    ks = np.array(
        [
            k_of(trimmed_fit(data[np.concatenate([by_run[i] for i in pick])]))
            for pick in (
                rng.integers(0, len(runs), len(runs)) for _ in range(BOOTSTRAPS)
            )
        ]
    )
    finite = ks[np.isfinite(ks)]
    fit.finite = len(finite) / BOOTSTRAPS
    if len(finite):
        fit.lo, fit.hi = (float(v) for v in np.percentile(finite, [5, 95]))
    return fit


def fit_all(rows: Iterable[Mapping[str, Any]]) -> list[ConfigFit]:
    """Every config's fit, most shards first."""
    fits = [fit_config(env, config, d) for (env, config), d in group(rows).items()]
    return sorted(fits, key=lambda f: (-f.shards, f.build_env, f.test_config))


def table(fits: Iterable[ConfigFit]) -> dict[str, dict[str, float]]:
    """{build env: {test config: k}} of the accepted fits with valid names, at most
    MAX_BUILD_ENVS envs and MAX_TEST_CONFIGS configs per env, most shards first."""
    shards_of: dict[str, int] = {}
    per_env: dict[str, list[ConfigFit]] = {}
    for f in fits:
        if f.accepted and valid_name(f.build_env) and valid_name(f.test_config):
            per_env.setdefault(f.build_env, []).append(f)
            shards_of[f.build_env] = shards_of.get(f.build_env, 0) + f.shards
    envs = sorted(per_env, key=lambda e: (-shards_of[e], e))[:MAX_BUILD_ENVS]
    out = {}
    for env in envs:
        best = sorted(per_env[env], key=lambda f: (-f.shards, f.test_config))
        out[env] = {f.test_config: round_sig(f.k) for f in best[:MAX_TEST_CONFIGS]}
    return out


def text(fits: Iterable[ConfigFit]) -> str:
    fits = list(fits)
    accepted = [f for f in fits if f.accepted]
    rejected = [f for f in fits if not f.accepted]
    lines = [
        f"start-up per file (k, test-case seconds) of {len(accepted)} configs;"
        " the others keep TD's cut:"
    ]
    lines += [
        f"  {f.build_env!r} {f.test_config!r}: shards {f.shards}, runs {f.runs},"
        f" c {f.c:.0f}, a {f.a:.3f}, k {f.k:.1f} (90% {f.lo:.1f}..{f.hi:.1f})"
        for f in accepted
    ]
    fitted = [f for f in rejected if f.shards >= MIN_SHARDS and f.runs >= MIN_RUNS]
    lines.append(
        f"{len(rejected)} configs rejected, {len(rejected) - len(fitted)} of them with"
        f" fewer than {MIN_SHARDS} shards or {MIN_RUNS} runs; the others:"
    )
    lines += [
        f"  {f.build_env!r} {f.test_config!r}: shards {f.shards}, runs {f.runs},"
        f" a {f.a:.3f}, k {f.k:.1f} (90% {f.lo:.1f}..{f.hi:.1f}): {f.reason}"
        for f in fitted
    ]
    return "\n".join(lines)
