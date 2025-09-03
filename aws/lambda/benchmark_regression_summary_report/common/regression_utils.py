import logging
import math
from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict
import statistics
from dateutil.parser import isoparse
from common.config_model import BenchmarkConfig, RegressionPolicy
from common.benchmark_time_series_api_model import (
    BenchmarkTimeSeriesApiData,
)

RegressionClassifyLabel = Literal[
    "regression", "suspicious", "no_regression", "insufficient_data"
]


class BaselineItem(TypedDict):
    group_info: Dict[str, Any]
    value: float


class LatestItem(TypedDict):
    group_info: Dict[str, Any]
    values: List[Dict[str, Any]]


class PerGroupResult(TypedDict, total=True):
    group_info: Dict[str, Any]
    baseline: Optional[float]
    points: List[Any]
    flags: List[bool]
    label: RegressionClassifyLabel
    policy: Optional["RegressionPolicy"]


def percentile(values: list[float], q: float):
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * q
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return v[int(k)]
    return v[f] + (v[c] - v[f]) * (k - f)


class BenchmarkRegressionReportGenerator:
    def __init__(
        self,
        config: BenchmarkConfig,
        latest_ts: BenchmarkTimeSeriesApiData,
        baseline_ts: BenchmarkTimeSeriesApiData,
    ) -> None:
        self.metric_policies = config.policy.metrics
        self.latest_ts = self._to_latest_data_map(latest_ts)
        self.baseline_ts = self._to_baseline_map(baseline_ts)

    def generate(self) -> Tuple[List[PerGroupResult], bool]:
        return self.detect_regressions_with_policies(
            self.baseline_ts,
            self.latest_ts,
            metric_policies=self.metric_policies,
        )

    def detect_regressions_with_policies(
        self,
        baseline_map: Dict[tuple, BaselineItem],
        dp_map: Dict[tuple, LatestItem],
        *,
        metric_policies: Dict[str, RegressionPolicy],
        min_points: int = 2,
    ) -> Tuple[List[PerGroupResult], bool]:
        """
        For each group:
        - choose policy by group_info['metric']
        - compute flags via policy.is_violation(value, baseline)
        - classify with classify_flags
        Returns a list of {group_info, baseline, values, flags, label, policy}
        """
        results: List[PerGroupResult] = []

        is_any_regression = False

        for key in sorted(dp_map.keys()):
            cur_item = dp_map.get(key)
            gi = cur_item["group_info"] if cur_item else {}
            points: List[Any] = cur_item["values"] if cur_item else []

            base_item = baseline_map.get(key)
            baseline_value = base_item.get("value") if base_item else None

            #
            policy = self._resolve_policy(metric_policies, gi.get("metric", ""))
            if not policy:
                results.append(
                    PerGroupResult(
                        group_info=gi,
                        baseline=baseline_value,
                        points=[],
                        flags=[],
                        label="insufficient_data",
                        policy=None,
                    )
                )
                continue

            if baseline_value is None or len(points) == 0:
                results.append(
                    PerGroupResult(
                        group_info=gi,
                        baseline=baseline_value,
                        points=[],
                        flags=[],
                        label="insufficient_data",
                        policy=policy,
                    )
                )
                continue

            # Per-point violations (True = regression)
            flags: List[bool] = [
                policy.is_violation(p["value"], baseline_value) for p in points
            ]
            label = self.classify_flags(flags, min_points=min_points)

            enriched_points = [{**p, "flag": f} for p, f in zip(points, flags)]
            results.append(
                PerGroupResult(
                    group_info=gi,
                    baseline=baseline_value,
                    points=enriched_points,
                    flags=[],
                    label=label,
                    policy=policy,
                )
            )
            if label == "regression":
                is_any_regression = True
        return results, is_any_regression

    def _to_latest_data_map(
        self, data: "BenchmarkTimeSeriesApiData", field: str = "value"
    ) -> Dict[tuple, LatestItem]:
        result: Dict[tuple, LatestItem] = {}
        for ts_group in data.time_series:
            group_keys = tuple(sorted(ts_group.group_info.items()))
            points: List[Dict[str, Any]] = []
            for d in sorted(
                ts_group.data, key=lambda d: isoparse(d["granularity_bucket"])
            ):
                if field not in d:
                    continue

                points.append(
                    {
                        "value": float(d[field]),
                        "commit": d.get("head_sha"),
                        "branch": d.get("head_branch"),
                        "timestamp": isoparse(d["granularity_bucket"]),
                    }
                )
            result[group_keys] = {
                "group_info": ts_group.group_info,
                "values": points,
            }
        return result

    def _to_baseline_map(
        self,
        baseline: BenchmarkTimeSeriesApiData,
        mode: str = "mean",
        field: str = "value",
    ) -> Dict[tuple, BaselineItem]:
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

    def classify_flags(
        self, flags: list[bool], min_points: int = 3
    ) -> RegressionClassifyLabel:
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

    def _resolve_policy(
        self,
        metric_policies: Dict[str, RegressionPolicy],
        metric: str,
    ) -> Optional[RegressionPolicy]:
        if not metric:
            return None
        m = metric.lower()
        return metric_policies.get(m)
