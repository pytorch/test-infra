import logging
import math
import statistics
from typing import Any, Counter, Dict, List, Literal, Optional, Tuple, TypedDict

from common.benchmark_time_series_api_model import BenchmarkTimeSeriesApiData
from common.config_model import BenchmarkConfig, RegressionPolicy
from dateutil.parser import isoparse


logger = logging.getLogger()

RegressionClassifyLabel = Literal[
    "regression", "suspicious", "no_regression", "insufficient_data"
]


class BaselineItem(TypedDict):
    group_info: Dict[str, Any]
    value: float


class BenchmarkValueItem(TypedDict):
    group_info: Dict[str, Any]
    values: List[Dict[str, Any]]


class PerGroupResult(TypedDict, total=True):
    group_info: Dict[str, Any]
    baseline: Optional[float]
    points: List[Any]
    label: RegressionClassifyLabel
    policy: Optional["RegressionPolicy"]


def percentile(values: list[float], q: float):
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
        self.latest_ts = self._to_data_map(latest_ts)
        self.baseline_raw = self._to_data_map(baseline_ts)

    def generate(self) -> Tuple[List[PerGroupResult], Dict[str, Any]]:
        return self.detect_regressions_with_policies(
            self.baseline_raw,
            self.latest_ts,
            metric_policies=self.metric_policies,
        )

    def detect_regressions_with_policies(
        self,
        baseline_map: Dict[tuple, BenchmarkValueItem],
        dp_map: Dict[tuple, BenchmarkValueItem],
        *,
        metric_policies: Dict[str, RegressionPolicy],
        min_points: int = 2,
    ) -> Tuple[List[PerGroupResult], Dict[str, Any]]:
        """
        For each dp_map:
        - choose policy based on targeting metric from group_info['metric'] (ex passrate, geomean ..)
        - calculate baseline value based on policy.baseline_aggregation (ex mean, p90, max, min, latest, p50, p95)
        - use baseline value to generate violation flag list for each point, using policy.is_violation(value, baseline)
        - classify with labels to detect regression, using self.classify_flags(flags, min_points)
        Returns a list of Regression result {group_info, baseline, values, flags, label, policy}
        """
        logger.info("Generating regression results ...")
        results: List[PerGroupResult] = []

        for key in sorted(dp_map.keys()):
            cur_item = dp_map.get(key)
            gi = cur_item["group_info"] if cur_item else {}
            points: List[Any] = cur_item["values"] if cur_item else []

            base_item = baseline_map.get(key)
            if not base_item:
                logger.warning("Skip. No baseline item found for %s", gi)
                results.append(
                    PerGroupResult(
                        group_info=gi,
                        baseline=None,
                        points=[],
                        label="insufficient_data",
                        policy=None,
                    )
                )
                continue
            policy = self._resolve_policy(metric_policies, gi.get("metric", ""))
            if not policy:
                logger.warning("No policy for %s", gi)
                results.append(
                    PerGroupResult(
                        group_info=gi,
                        baseline=None,
                        points=[],
                        label="insufficient_data",
                        policy=None,
                    )
                )
                continue

            baseline_aggre_mode = policy.baseline_aggregation
            baseline_value = self._get_baseline(base_item, baseline_aggre_mode)
            if baseline_value is None or len(points) == 0:
                logger.warning(
                    "baseline_value is %s, len(points) == %s",
                    baseline_value,
                    len(points),
                )
                results.append(
                    PerGroupResult(
                        group_info=gi,
                        baseline=None,
                        points=[],
                        label="insufficient_data",
                        policy=policy,
                    )
                )
                continue

            # Per-point violations (True = regression)
            flags: List[bool] = [
                policy.is_violation(p["value"], baseline_value["value"]) for p in points
            ]
            label = self.classify_flags(flags, min_points=min_points)

            enriched_points = [{**p, "flag": f} for p, f in zip(points, flags)]
            results.append(
                PerGroupResult(
                    group_info=gi,
                    baseline=baseline_value["value"],
                    points=enriched_points,
                    label=label,
                    policy=policy,
                )
            )

        logger.info("Done. Generated %s regression results", len(results))
        summary = self.summarize_label_counts(results)
        return results, summary

    def summarize_label_counts(self, results: list[PerGroupResult]):
        counts = Counter(self._label_str(r["label"]) for r in results)
        total_count = len(results)
        return {
            "total_count": total_count,
            "regression_count": counts.get("regression", 0),
            "suspicious_count": counts.get("suspicious", 0),
            "no_regression_count": counts.get("no_regression", 0),
            "insufficient_data_count": counts.get("insufficient_data", 0),
            "is_regression": int(counts.get("regression", 0) > 0),
        }

    def _label_str(self, x) -> str:
        # Robust: works for str or Enum-like labels
        if isinstance(x, str):
            return x.lower()
        if hasattr(x, "value"):
            v = x.value
            return (v if isinstance(v, str) else str(v)).lower()
        return str(x).lower()

    def _to_data_map(
        self, data: "BenchmarkTimeSeriesApiData", field: str = "value"
    ) -> Dict[tuple, BenchmarkValueItem]:
        result: Dict[tuple, BenchmarkValueItem] = {}
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
                        "commit": d.get("commit"),
                        "branch": d.get("branch"),
                        "timestamp": isoparse(d["granularity_bucket"]),
                    }
                )
            result[group_keys] = {
                "group_info": ts_group.group_info,
                "values": points,
            }
        return result

    def _get_baseline(
        self,
        data: BenchmarkValueItem,
        mode: str = "mean",
        field: str = "value",
    ) -> Optional[BaselineItem]:
        """
        calculate the baseline value based on the mode
        mode: mean, p90, max, min, latest, p50, p95
        """
        values = [float(d[field]) for d in data["values"] if field in d]
        if not values:
            return None

        if mode == "mean":
            val = statistics.fmean(values)
        elif mode == "p90":
            val = percentile(values, 0.9)
        elif mode == "max":
            val = max(values)
        elif mode == "min":
            val = min(values)
        elif mode == "latest":
            val = values[-1]
        elif mode == "earliest":
            val = values[0]
        elif mode == "p50":
            val = percentile(values, 0.5)
        elif mode == "p95":
            val = percentile(values, 0.95)
        else:
            logger.warning("Unknown mode: %s", mode)
            return None
        result: BaselineItem = {
            "group_info": data["group_info"],
            "value": val,
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
