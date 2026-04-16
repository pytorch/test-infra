import datetime as dt
import json
import logging
import math
import statistics
from typing import Any, Counter, Dict, List, Literal, Optional, TypedDict

from common.benchmark_time_series_api_model import (
    BenchmarkTimeSeriesApiData,
    BenchmarkTimeSeriesItem,
)
from common.config_model import BenchmarkConfig, RegressionPolicy
from dateutil.parser import isoparse


logger = logging.getLogger()

RegressionClassifyLabel = Literal[
    "regression", "suspicious", "no_regression", "insufficient_data"
]


class TimeSeriesDataMetaInfo(TypedDict):
    commit: str
    branch: str
    timestamp: str
    workflow_id: str


class TimeSeriesMetaInfo(TypedDict):
    start: TimeSeriesDataMetaInfo
    end: TimeSeriesDataMetaInfo


class BenchmarkRegressionSummary(TypedDict):
    total_count: int
    regression_count: int
    suspicious_count: int
    no_regression_count: int
    insufficient_data_count: int
    is_regression: int


class BenchmarkRegressionPoint(TypedDict):
    value: float
    commit: str
    branch: str
    workflow_id: str
    timestamp: str


class BaselineResult(TypedDict):
    group_info: Dict[str, Any]
    original_point: BenchmarkRegressionPoint
    all_baseline_points: List[BenchmarkRegressionPoint]
    value: float


class BenchmarkRegressionPointGroup(TypedDict):
    group_info: Dict[str, Any]
    values: List[BenchmarkRegressionPoint]


class PerGroupResult(TypedDict, total=True):
    group_info: Dict[str, Any]
    baseline_point: Optional[BenchmarkRegressionPoint]
    points: List[Any]
    label: RegressionClassifyLabel
    policy: Optional["RegressionPolicy"]
    all_baseline_points: List[BenchmarkRegressionPoint]


class BenchmarkRegressionReport(TypedDict):
    summary: BenchmarkRegressionSummary
    results: List[PerGroupResult]
    baseline_meta_data: TimeSeriesMetaInfo
    new_meta_data: TimeSeriesMetaInfo
    device_info: List[str]
    metadata: Optional[Any]


def get_regression_status(regression_summary: BenchmarkRegressionSummary) -> str:
    if regression_summary.get("regression_count", 0) > 0:
        return "regression"
    if regression_summary.get("suspicious_count", 0) > 0:
        return "suspicious"
    if regression_summary.get("insufficient_data_count", 0) > 0:
        insufficient_data = regression_summary.get("insufficient_data_count", 0)
        # default to 1 to avoid dividen issue
        total = regression_summary.get("total_count", 1)
        percentage = insufficient_data / total
        if percentage >= 0.9:
            return "insufficient_data"
    return "no_regression"


class BenchmarkRegressionReportGenerator:
    def __init__(
        self,
        config: BenchmarkConfig,
        target_ts: BenchmarkTimeSeriesApiData,
        baseline_ts: BenchmarkTimeSeriesApiData,
    ) -> None:
        self.metric_policies = config.policy.metrics
        self.baseline_ts_info = self._get_meta_info(baseline_ts.time_series)
        self.lastest_ts_info = self._get_meta_info(target_ts.time_series)
        self.target_ts = self._to_data_map(target_ts)
        self.baseline_ts = self._to_data_map(baseline_ts)
        # collect device info from target_ts
        self.device_info = self._to_device_info(target_ts)

    def generate(self) -> BenchmarkRegressionReport:
        if not self.baseline_ts or not self.target_ts:
            logger.warning("No baseline or target data found")
            raise ValueError("No baseline or target data found")

        return self.detect_regressions_with_policies(
            self.baseline_ts,
            self.target_ts,
            metric_policies=self.metric_policies,
        )

    def detect_regressions_with_policies(
        self,
        baseline_map: Dict[tuple, BenchmarkRegressionPointGroup],
        dp_map: Dict[tuple, BenchmarkRegressionPointGroup],
        *,
        metric_policies: Dict[str, RegressionPolicy],
        min_points: int = 2,
    ) -> BenchmarkRegressionReport:
        """
        For each dp_map:
        - choose policy based on targeting metric from group_info['metric'] (ex passrate, geomean ..)
        - calculate baseline value based on policy.baseline_aggregation (ex mean, p90, max, min, target, p50, p95)
        - use baseline value to generate violation flag list for each point, using policy.is_violation(value, baseline)
        - classify with labels to detect regression, using self.classify_flags(flags, min_points)
        Returns a list of Regression result {group_info, baseline, values, flags, label, policy}
        """
        logger.info("Generating regression results ...")
        results: List[PerGroupResult] = []

        missing_policy = set()  # for logging

        for key in sorted(dp_map.keys()):
            cur_item = dp_map.get(key)
            gi = cur_item["group_info"] if cur_item else {}
            points: List[Any] = cur_item["values"] if cur_item else []

            policy = self._resolve_policy(metric_policies, gi.get("metric", ""))
            if not policy:
                missing_policy.add(gi.get("metric", ""))
                continue

            base_item = baseline_map.get(key)
            if not base_item:
                results.append(
                    PerGroupResult(
                        group_info=gi,
                        baseline_point=None,
                        points=[],
                        label="insufficient_data",
                        policy=None,
                        all_baseline_points=[],
                    )
                )
                continue
            baseline_aggre_mode = policy.baseline_aggregation
            baseline_result = self._get_baseline(base_item, baseline_aggre_mode)
            if (
                not baseline_result
                or not baseline_result["original_point"]
                or len(points) == 0
            ):
                logger.warning(
                    "No valid baseline result found, baseline_point is %s, len(points) == %s",
                    baseline_result,
                    len(points),
                )
                results.append(
                    PerGroupResult(
                        group_info=gi,
                        baseline_point=None,
                        points=[],
                        label="insufficient_data",
                        policy=policy,
                        all_baseline_points=[],
                    )
                )
                continue

            orignal_baseline_obj = baseline_result["original_point"]

            # Per-point violations (True = regression)
            flags: List[bool] = [
                policy.is_violation(p["value"], baseline_result["value"])
                for p in points
            ]
            label = self.classify_flags(flags, min_points=min_points)

            enriched_points = [{**p, "flag": f} for p, f in zip(points, flags)]
            results.append(
                PerGroupResult(
                    group_info=gi,
                    baseline_point=orignal_baseline_obj,
                    points=enriched_points,
                    label=label,
                    policy=policy,
                    all_baseline_points=baseline_result["all_baseline_points"],
                )
            )
        logger.info("Done. Generated %s regression results", len(results))
        summary = self.summarize_label_counts(results)
        metadata = self.generate_metadata(results)

        logger.info(
            "Found metrics existed in data, but no regression policy detected: %s",
            missing_policy,
        )

        return BenchmarkRegressionReport(
            summary=summary,
            results=results,
            baseline_meta_data=self.baseline_ts_info,
            new_meta_data=self.lastest_ts_info,
            device_info=self.device_info,
            metadata=metadata,
        )

    def generate_metadata(
        self, results: list[PerGroupResult]
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Fetch distinct (arch, device) pairs that have label 'regression' or 'suspicious',
        along with the count of regressions for each device.

        Returns:
            Dict with 'regression_devices' and 'suspicious_devices' keys,
            each containing a list of {"arch": ..., "device": ..., "count": ...} dicts.
        """
        regression_device_counts: Counter[tuple[str, str]] = Counter()
        suspicious_device_counts: Counter[tuple[str, str]] = Counter()

        for result in results:
            label = result.get("label")
            group_info = result.get("group_info", {})
            arch = group_info.get("arch", "")
            device = group_info.get("device", "")

            if label == "regression":
                regression_device_counts[(arch, device)] += 1
            elif label == "suspicious":
                suspicious_device_counts[(arch, device)] += 1
        return {
            "regression_devices": [
                {"arch": arch, "device": device, "count": count}
                for (arch, device), count in regression_device_counts.items()
            ],
            "suspicious_devices": [
                {"arch": arch, "device": device, "count": count}
                for (arch, device), count in suspicious_device_counts.items()
            ],
        }

    def summarize_label_counts(
        self, results: list[PerGroupResult]
    ) -> BenchmarkRegressionSummary:
        counts = Counter(self._label_str(r["label"]) for r in results)
        total_count = len(results)
        summmary: BenchmarkRegressionSummary = {
            "total_count": total_count,
            "regression_count": counts.get("regression", 0),
            "suspicious_count": counts.get("suspicious", 0),
            "no_regression_count": counts.get("no_regression", 0),
            "insufficient_data_count": counts.get("insufficient_data", 0),
            "is_regression": int(counts.get("regression", 0) > 0),
        }
        return summmary

    def _label_str(self, x) -> str:
        # Robust: works for str or Enum-like labels
        if isinstance(x, str):
            return x.lower()
        if hasattr(x, "value"):
            v = x.value
            return (v if isinstance(v, str) else str(v)).lower()
        return str(x).lower()

    def _to_device_info(self, data: "BenchmarkTimeSeriesApiData") -> List[str]:
        result = set()
        for ts_group in data.time_series:
            device = ts_group.group_info.get("device", "")
            arch = ts_group.group_info.get("arch", "")
            key = ""
            if device and arch:
                key = f"{device}_{arch}"
            elif device:
                key = device

            if not key:
                continue
            result.add(key)
        return list(result)

    def _to_data_map(
        self, data: "BenchmarkTimeSeriesApiData", field: str = "value"
    ) -> Dict[tuple, BenchmarkRegressionPointGroup]:
        result: Dict[tuple, BenchmarkRegressionPointGroup] = {}
        for ts_group in data.time_series:
            group_keys = tuple(sorted(ts_group.group_info.items()))
            points: List[BenchmarkRegressionPoint] = []
            for d in sorted(
                ts_group.data, key=lambda d: isoparse(d["granularity_bucket"])
            ):
                # skip if field is not in data, or field is None
                if field not in d:
                    logger.warning(
                        "[_to_data_map] field %s not found or value is undefined", field
                    )
                    continue
                if d[field] is None or math.isnan(float(d[field])):
                    logger.warning(
                        "[_to_data_map] Skip %s with value %s with group key [%s]",
                        field,
                        d[field],
                        group_keys,
                    )
                    continue

                p: BenchmarkRegressionPoint = {
                    "value": float(d[field]),
                    "commit": d.get("commit", ""),
                    "branch": d.get("branch", ""),
                    "workflow_id": d.get("workflow_id", ""),
                    "timestamp": d.get("granularity_bucket", ""),
                }
                points.append(p)
            result[group_keys] = {
                "group_info": ts_group.group_info,
                "values": points,
            }
        return result

    def _get_baseline(
        self,
        data: BenchmarkRegressionPointGroup,
        mode: str = "max",
        field: str = "value",
    ) -> Optional[BaselineResult]:
        """
        calculate the baseline value based on the mode
        mode: mean, p90, max, min, target, p50, p95
        """
        items = [
            d
            for d in data["values"]
            if field in d and d[field] is not None and not math.isnan(float(d[field]))
        ]
        if not items:
            return None
        if mode == "max":
            baseline_obj = max(items, key=lambda d: float(d[field]))
        elif mode == "min":
            baseline_obj = min(items, key=lambda d: float(d[field]))
        elif mode == "target":
            baseline_obj = items[-1]
        elif mode == "earliest":
            baseline_obj = items[0]
        elif mode == "median":
            median_val = statistics.median([float(d[field]) for d in items])
            baseline_obj = min(items, key=lambda d: abs(float(d[field]) - median_val))
        else:
            logger.warning("Unknown mode: %s", mode)
            return None
        result: BaselineResult = {
            "group_info": data["group_info"],
            "value": float(baseline_obj[field]),
            "original_point": baseline_obj,
            "all_baseline_points": items,
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

    def _get_meta_info(
        self,
        time_series: List[BenchmarkTimeSeriesItem],
    ) -> TimeSeriesMetaInfo:
        pts = [p for s in time_series for p in s.data]
        end_data = max(
            pts,
            key=lambda p: dt.datetime.fromisoformat(
                p["granularity_bucket"].replace("Z", "+00:00")
            ),
        )
        start_data = min(
            pts,
            key=lambda p: dt.datetime.fromisoformat(
                p["granularity_bucket"].replace("Z", "+00:00")
            ),
        )
        end: TimeSeriesDataMetaInfo = {
            "commit": end_data.get("commit", ""),
            "branch": end_data.get("branch", ""),
            "timestamp": end_data.get("granularity_bucket", ""),
            "workflow_id": end_data.get("workflow_id", ""),
        }
        start: TimeSeriesDataMetaInfo = {
            "commit": start_data.get("commit", ""),
            "branch": start_data.get("branch", ""),
            "timestamp": start_data.get("granularity_bucket", ""),
            "workflow_id": start_data.get("workflow_id", ""),
        }
        return {"start": start, "end": end}


def dict_to_string_map(d: dict) -> dict[str, str]:
    return {
        str(k): (
            v
            if isinstance(v, str)
            else json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        )
        for k, v in d.items()
        if v is not None
    }
