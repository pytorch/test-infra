import logging
import math
from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict
import statistics
from dateutil.parser import isoparse
from common.config_model import RegressionPolicy
from common.benchmark_time_series_api_model import (
    BenchmarkTimeSeriesApiData,
    BenchmarkTimeSeriesItem,
)

RegressionClassifyLabel = Literal[
    "regression", "suspicious", "no_regression", "insufficient_data"
]


class BaselineItem(TypedDict):
    group_info: Dict[str, Any]
    value: float


class LatestItem(TypedDict):
    group_info: Dict[str, Any]
    values: List[float]


def to_latest_data_map(
    data: BenchmarkTimeSeriesApiData, field="value"
) -> Dict[tuple, LatestItem]:
    result = {}
    for ts_group in data.time_series:
        group_keys = tuple(sorted(ts_group.group_info.items()))
        values = [
            float(d[field])
            for d in sorted(
                ts_group.data,
                key=lambda d: isoparse(d["granularity_bucket"]),  # convert to datetime
            )
            if field in d
        ]
        result[group_keys] = {
            "group_info": ts_group.group_info,
            "values": values,
        }
    return result


def to_baseline_map(
    baseline: BenchmarkTimeSeriesApiData,
    mode: str = "mean",
    field: str = "value",
) -> Dict[tuple, BaselineItem]:
    """
    return
      {
        group_key[tuple]: {
          "group_info": {...},
          "baseline": float
        }
      }
    """
    result = {}
    for ts_group in baseline.time_series:
        group_keys = tuple(sorted(ts_group.group_info.items()))
        values = [float(d[field]) for d in ts_group.data if field in d]
        if not values:
            continue

        if mode == "mean":
            val = statistics.fmean(values)
        elif mode == "p90":
            val = percentile(values, 0.9)
        else:
            raise ValueError("mode must be 'mean' or 'p90'")

        result[group_keys] = {
            "group_info": ts_group.group_info,
            "baseline": val,
        }
    return result


def classify_flags(flags: list[bool], min_points: int = 3) -> RegressionClassifyLabel:
    """
    Classify a sequence of boolean flags to detect regression.

    - regression: last run has >= 2 consecutive True values
    - suspicious: there is a run of >= 3 consecutive True values, but not at the end
    - no_regression: all other cases
    - insufficient_data: not enough data points (< min_points)

    Special case:
    - If min_points == 1, then just look at the last flag:
        True  -> regression
        False -> no_regression
    """
    n = len(flags)
    if n == 0:
        return "insufficient_data"

    if min_points == 1:
        return "regression" if flags[-1] else "no_regression"

    if n < min_points:
        return "insufficient_data"

    # trailing run length
    t = 0
    for v in reversed(flags):
        if v:
            t += 1
        else:
            break
    if t >= 2:
        return "regression"

    # longest run anywhere
    longest = cur = 0
    for v in flags:
        cur = cur + 1 if v else 0
        longest = max(longest, cur)

    if longest >= 3:
        return "suspicious"

    return "no_regression"


def percentile(values, q: float):
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * q
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return v[int(k)]
    return v[f] + (v[c] - v[f]) * (k - f)


def _resolve_policy(
    metric_policies: Dict[str, RegressionPolicy],
    metric: str,
) -> Optional[RegressionPolicy]:
    if not metric:
        return None
    m = metric.lower()
    return metric_policies.get(m)


def detect_regressions_with_policies(
    baseline_map: Dict[tuple, BaselineItem],
    latest_map: Dict[tuple, LatestItem],
    *,
    metric_policies: Dict[str, RegressionPolicy],
    min_points: int = 2,
) -> Tuple[List[Dict[str, Any]], bool]:
    """
    For each group:
      - choose policy by group_info['metric']
      - compute flags via policy.is_violation(value, baseline)
      - classify with classify_flags
    Returns a list of {group_info, baseline, values, flags, label, policy}
    """
    results: List[Dict[str, Any]] = []

    is_any_regression = False

    for key in sorted(latest_map.keys()):
        cur_item = latest_map.get(key)
        gi = cur_item["group_info"] if cur_item else {}
        latest_vals = cur_item["values"] if cur_item else []
        policy = _resolve_policy(metric_policies, gi.get("metric", ""))
        if not policy:
            logging.warning(
                f"no policy for metric %s with group_info=%s", gi.get("metric", ""), gi
            )
            continue

        base_item = baseline_map.get(key)
        baseline_value = base_item.get("value") if base_item else None
        if not base_item or not baseline_value:
            logging.warning(
                f"no baseline for metric %s with group_info=%s",
                gi.get("metric", ""),
                gi,
            )
            continue

        # Per-point violations (True = regression)
        flags = [policy.is_violation(v, baseline_value) for v in latest_vals]
        label = classify_flags(flags, min_points=min_points)
        results.append(
            {
                "group_info": gi,
                "baseline": baseline_value,
                "values": latest_vals,
                "flags": flags,
                "label": label,
                "policy": policy,
            }
        )
        if label == "regression":
            is_any_regression = True
    return results, is_any_regression
