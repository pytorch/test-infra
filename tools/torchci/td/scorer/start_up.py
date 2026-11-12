"""Per-config start-up seconds k, fitted on the test shards of the days before a refit.

Per successful test job (one shard) of a TD workflow on a TD platform: y is its "Test"
step seconds; s the sum of its test seconds and n its distinct test files, both from
default.test_run_summary, the rows test-times.json averages. Per (build env, test
config), shards above the 99th percentile of n or s are left out, so a few crafted
shards cannot lever the fit; y ~ c + a*s + b*n is fitted by least squares, with one pass
that drops residuals beyond TRIM_MADS robust standard deviations, and k = b / a: the
start-up of one file in test seconds. The cut only depends on k, because the budget is
TD's own cut costed the same way, so a scales both sides. A bootstrap over head SHAs
gives k's 90% interval, which must not reach below MIN_START_UP_SECONDS. Only accepted
fits enter the table; a config without one keeps
TD's cut.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable, Mapping, Optional

import numpy as np
from torchci.td.scorer import shards
from torchci.td.scorer.model_json import (
    MAX_BUILD_ENVS,
    MAX_START_UP_SECONDS,
    MAX_TEST_CONFIGS,
    MIN_START_UP_SECONDS,
    round_sig,
    valid_name,
)
from torchci.td.scorer.rows_sql import IS_FILE, JOB_COLUMNS, SETTINGS, TD_JOB_SUCCESS


DAYS = 7
MAX_SHARD_SECONDS = 4 * 3600
MAX_SHARD_FILES = 2000
MAX_SECONDS_RATIO = 16
EXTREME_PERCENTILE = 99
MIN_SHARDS = 300
MIN_RUNS = 30
MIN_HEADS = 30
MIN_A = 0.1
TRIM_MADS = 5
BOOTSTRAPS = 60
SEED = 0
MIN_FINITE = 0.95
MAX_WIDTH_RATIO = 0.5
MIN_MAX_WIDTH = 4.0
MIN_ACCEPTED_CONFIGS = 5
RUN, HEAD, Y, S, N = range(5)

# The latest row of each job (ORDER BY _inserted_at DESC LIMIT 1 BY id) is filtered after
# the dedupe, so an earlier row's conclusion never decides. Numbers come back as Float64
# (JSONEachRow quotes 64-bit integers), a non-finite one as -1, out of group's bounds.
SQL = f"""
WITH
    jobs AS (
        SELECT id, run_id, head_sha, build_env, test_config, y
        FROM (
            SELECT id, run_id, head_sha, workflow_name AS workflow, status, conclusion,
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
        WHERE {TD_JOB_SUCCESS} AND length(test_steps) = 1
    ),
    files AS (
        SELECT job_id, workflow_id, sum(time) AS s, uniqExact(invoking_file) AS n
        FROM default.test_run_summary
        WHERE workflow_id IN (SELECT run_id FROM jobs)
            AND job_id IN (SELECT id FROM jobs) AND file != '' AND {IS_FILE}
        GROUP BY job_id, workflow_id
    )
SELECT j.build_env AS build_env, j.test_config AS test_config, j.run_id AS run_id,
    j.head_sha AS head_sha, ifNotFinite(toFloat64(j.y), -1) AS y,
    ifNotFinite(toFloat64(f.s), -1) AS s, toFloat64(f.n) AS n
FROM files AS f
INNER JOIN jobs AS j ON j.id = f.job_id AND j.run_id = f.workflow_id
{SETTINGS}
"""


def fetch(day: date) -> list[dict[str, Any]]:
    """The shards of the DAYS days before `day`, one query per day."""
    out: list[dict[str, Any]] = []
    for i in range(DAYS, 0, -1):
        d = day - timedelta(days=i)
        out.extend(shards.query("td_scorer_start_up", SQL, shards.ch_day(d)))
    return out


def number(value: Any) -> float:
    """`value` as a float; NaN for null or anything not numeric."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def in_bounds(y: float, s: float, n: float) -> bool:
    return (
        0 < y <= MAX_SHARD_SECONDS
        and 1 <= n <= MAX_SHARD_FILES
        and 0 <= s <= MAX_SECONDS_RATIO * y
    )


def drop_extremes(data: np.ndarray) -> np.ndarray:
    """The shards whose n and s are both at most their EXTREME_PERCENTILE."""
    n_top, s_top = np.percentile(data[:, [N, S]], EXTREME_PERCENTILE, axis=0)
    return data[(data[:, N] <= n_top) & (data[:, S] <= s_top)]


def group(rows: Iterable[Mapping[str, Any]]) -> dict[tuple[str, str], np.ndarray]:
    """Per (build env, test config) of a TD platform, its in-bounds shards without the
    extremes (drop_extremes), as rows of (run, head index, y, s, n)."""
    by: dict[tuple[str, str], list[tuple[float, ...]]] = {}
    heads: dict[str, int] = {}
    for r in rows:
        env, config = r["build_env"], r["test_config"]
        y, s, n = number(r["y"]), number(r["s"]), number(r["n"])
        if not shards.td_platform(env) or not in_bounds(y, s, n):
            continue
        head = heads.setdefault(str(r["head_sha"]), len(heads))
        by.setdefault((env, config), []).append(
            (number(r["run_id"]), float(head), y, s, n)
        )
    return {key: drop_extremes(np.array(v, dtype=float)) for key, v in by.items()}


def design(data: np.ndarray) -> np.ndarray:
    return np.column_stack([np.ones(len(data)), data[:, S], data[:, N]])


def ols(data: np.ndarray) -> Optional[np.ndarray]:
    """(c, a, b) of y ~ c + a*s + b*n, or None when n takes fewer than three distinct
    values or s and n are collinear with the intercept."""
    if len(np.unique(data[:, N])) < 3:
        return None
    x = design(data)
    if np.linalg.matrix_rank(x) < 3:
        return None
    beta, *_ = np.linalg.lstsq(x, data[:, Y], rcond=None)
    return beta  # type: ignore[no-any-return]


def trimmed_fit(data: np.ndarray) -> Optional[np.ndarray]:
    beta = ols(data)
    if beta is None:
        return None
    res = data[:, Y] - design(data) @ beta
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
    heads: int
    c: float = float("nan")
    a: float = float("nan")
    k: float = float("nan")
    lo: float = float("nan")
    hi: float = float("nan")
    finite: float = 0.0

    @property
    def enough(self) -> bool:
        return (
            self.shards >= MIN_SHARDS
            and self.runs >= MIN_RUNS
            and self.heads >= MIN_HEADS
        )

    @property
    def reason(self) -> str:
        """Why the fit is rejected, "" when every check holds; a NaN fails every
        comparison it is in."""
        if not self.enough:
            return "too few shards, runs or heads"
        if not np.isfinite(self.a):
            return "no fit: n or s does not vary enough"
        if not self.a >= MIN_A:
            return f"a not >= {MIN_A}"
        if not MIN_START_UP_SECONDS <= self.k <= MAX_START_UP_SECONDS:
            return f"k not in [{MIN_START_UP_SECONDS:g}, {MAX_START_UP_SECONDS:g}]"
        if not self.finite >= MIN_FINITE:
            return "bootstrap fits not finite"
        if not self.lo >= MIN_START_UP_SECONDS:
            return f"90% interval reaches below {MIN_START_UP_SECONDS:g} s"
        if not self.hi - self.lo <= max(MAX_WIDTH_RATIO * self.k, MIN_MAX_WIDTH):
            return "90% interval too wide"
        return ""

    @property
    def accepted(self) -> bool:
        return self.reason == ""


def fit_config(env: str, config: str, data: np.ndarray) -> ConfigFit:
    heads, head_of = np.unique(data[:, HEAD], return_inverse=True)
    runs = len(np.unique(data[:, RUN]))
    fit = ConfigFit(env, config, len(data), runs, len(heads))
    if not fit.enough:
        return fit
    beta = trimmed_fit(data)
    if beta is not None:
        fit.c, fit.a = float(beta[0]), float(beta[1])
    fit.k = k_of(beta)
    rng = np.random.default_rng(SEED)
    order = np.argsort(head_of, kind="stable")
    by_head = np.split(order, np.cumsum(np.bincount(head_of))[:-1])
    ks = np.array(
        [
            k_of(trimmed_fit(data[np.concatenate([by_head[i] for i in pick])]))
            for pick in (
                rng.integers(0, len(heads), len(heads)) for _ in range(BOOTSTRAPS)
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


def size(start_up: Mapping[str, Mapping[str, float]]) -> int:
    return sum(len(configs) for configs in start_up.values())


def text(fits: Iterable[ConfigFit]) -> str:
    fits = list(fits)
    accepted = [f for f in fits if f.accepted]
    rejected = [f for f in fits if not f.accepted]
    lines = [
        f"start-up per file (k, test seconds) of {len(accepted)} configs;"
        " the others keep TD's cut:"
    ]
    lines += [
        f"  {f.build_env!r} {f.test_config!r}: shards {f.shards}, runs {f.runs},"
        f" heads {f.heads}, c {f.c:.0f}, a {f.a:.3f}, k {f.k:.1f}"
        f" (90% {f.lo:.1f}..{f.hi:.1f})"
        for f in accepted
    ]
    fitted = [f for f in rejected if f.enough]
    lines.append(
        f"{len(rejected)} configs rejected, {len(rejected) - len(fitted)} of them with"
        f" fewer than {MIN_SHARDS} shards, {MIN_RUNS} runs or {MIN_HEADS} heads;"
        " the others:"
    )
    lines += [
        f"  {f.build_env!r} {f.test_config!r}: shards {f.shards}, runs {f.runs},"
        f" heads {f.heads}, a {f.a:.3f}, k {f.k:.1f} (90% {f.lo:.1f}..{f.hi:.1f}):"
        f" {f.reason}"
        for f in fitted
    ]
    return "\n".join(lines)
