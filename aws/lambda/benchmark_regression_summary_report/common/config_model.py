from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Dict, Literal, Optional

from jinja2 import Environment, meta, Template


# -------- Frequency --------
@dataclass(frozen=True)
class Frequency:
    """
    The frequency of how often the report should be generated.
    The minimum frequency we support is 1 day.
    Attributes:
        value: Number of units (e.g., 7 for 7 days).
        unit: Unit of time, either "days" or "weeks".

    Methods:
        to_timedelta: Convert frequency into a datetime.timedelta.
        get_text: return the frequency in text format
    """

    value: int
    unit: Literal["days", "weeks"]

    def to_timedelta(self) -> timedelta:
        """Convert frequency N days or M weeks into a datetime.timedelta."""
        if self.unit == "days":
            return timedelta(days=self.value)
        elif self.unit == "weeks":
            return timedelta(weeks=self.value)
        else:
            raise ValueError(f"Unsupported unit: {self.unit}")

    def get_text(self):
        return f"{self.value}_{self.unit}"


# -------- Source --------
_JINJA_ENV = Environment(autoescape=False)


@dataclass
class BenchmarkApiSource:
    """
    Defines the source of the benchmark data we want to query
    api_query_url: the url of the api to query
    api_endpoint_params_template: the jinjia2 template of the api endpoint's query params
    default_ctx: the default context to use when rendering the api_endpoint_params_template
    """

    api_query_url: str
    api_endpoint_params_template: str
    type: Literal["benchmark_time_series_api", "other"] = "benchmark_time_series_api"
    default_ctx: Dict[str, Any] = field(default_factory=dict)

    def required_template_vars(self) -> set[str]:
        ast = _JINJA_ENV.parse(self.api_endpoint_params_template)
        return set(meta.find_undeclared_variables(ast))

    def render(self, ctx: Dict[str, Any], strict: bool = True) -> dict:
        """Render with caller-supplied context (no special casing for start/end)."""
        merged = {**self.default_ctx, **ctx}

        if strict:
            required = self.required_template_vars()
            missing = required - merged.keys()
            if missing:
                raise ValueError(f"Missing required vars: {missing}")
        rendered = Template(self.api_endpoint_params_template).render(**merged)
        return json.loads(rendered)


# -------- Policy: range windows --------
@dataclass
class DayRangeWindow:
    value: int
    # raw indicates fetch from the source data
    source: Literal["raw"] = "raw"


@dataclass
class RangeConfig:
    """
    Defines the range of baseline and comparison windows for a given policy.
    - baseline: the baseline window that build the baseline value
    - comparison: the comparison window that we fetch data from to compare against the baseline value
    """

    baseline: DayRangeWindow
    comparison: DayRangeWindow

    def total_timedelta(self) -> timedelta:
        return timedelta(days=self.baseline.value + self.comparison.value)

    def comparison_timedelta(self) -> timedelta:
        return timedelta(days=self.comparison.value)

    def baseline_timedelta(self) -> timedelta:
        return timedelta(days=self.baseline.value)


# -------- Policy: metrics --------
@dataclass
class RegressionPolicy:
    """
    Defines the policy for a given metric.
    - new value muset be {x} baseline value:
        - "greater_than": higher is better; new value must be strictly greater to baseline
        - "less_than":    lower  is better; new value must be strictly lower to baseline
        - "equal_to":     new value should be ~= baseline * threshold within rel_tol
        - "greater_equal": higher is better; new value must be greater or equal to baseline
        - "less_equal":    lower  is better; new value must be less or equal to baseline
    """

    name: str
    condition: Literal[
        "greater_than", "less_than", "equal_to", "greater_equal", "less_equal"
    ]
    threshold: float
    baseline_aggregation: Literal[
        "avg", "max", "min", "p50", "p90", "p95", "latest", "earliest"
    ] = "max"
    rel_tol: float = 1e-3  # used only for "equal_to"

    def is_violation(self, value: float, baseline: float) -> bool:
        target = baseline * self.threshold

        if self.condition == "greater_than":
            # value must be strictly greater than target
            return value <= target

        if self.condition == "greater_equal":
            # value must be greater or equal to target
            return value < target

        if self.condition == "less_than":
            # value must be strictly less than target
            return value >= target

        if self.condition == "less_equal":
            # value must be less or equal to target
            return value > target

        if self.condition == "equal_to":
            # |value - target| should be within rel_tol * max(1, |target|)
            denom = max(1.0, abs(target))
            return abs(value - target) > self.rel_tol * denom

        raise ValueError(f"Unknown condition: {self.condition}")


@dataclass
class Policy:
    frequency: Frequency
    range: RangeConfig
    metrics: Dict[str, RegressionPolicy]

    # TODO(elainewy): add notification config
    notification_config: Optional[Dict[str, Any]] = None


# -------- Top-level benchmark regression config --------
@dataclass
class BenchmarkConfig:
    """
    Represents a single benchmark regression configuration.
        - BenchmarkConfig defines the benchmark regression config for a given benchmark.
        - source: defines the source of the benchmark data we want to query
        - policy: defines the policy for the benchmark regressions, including frequency to
        generate the report, range of the baseline and new values, and regression thresholds
        for metrics
        - name:  the name of the benchmark
        - id: the id of the benchmark, this must be unique for each benchmark, and cannot be changed once set
    """

    name: str
    id: str
    source: BenchmarkApiSource
    policy: Policy


@dataclass
class BenchmarkRegressionConfigBook:
    configs: Dict[str, BenchmarkConfig] = field(default_factory=dict)

    def __getitem__(self, key: str) -> BenchmarkConfig:
        config = self.configs.get(key)
        if not config:
            raise KeyError(f"Config {key} not found")
        return config
