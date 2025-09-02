from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Optional, Set
from datetime import datetime, timedelta
from jinja2 import Environment, Template, meta
import json


# -------- Frequency --------
@dataclass
class Frequency:
    value: int
    unit: Literal["days", "weeks"]

    def to_timedelta(self) -> timedelta:
        """Convert frequency into a datetime.timedelta."""
        if self.unit == "days":
            return timedelta(days=self.value)
        elif self.unit == "weeks":
            return timedelta(weeks=self.value)
        else:
            raise ValueError(f"Unsupported unit: {self.unit}")


# -------- Source --------
_JINJA_ENV = Environment(autoescape=False)

@dataclass
class BenchmarkApiSource:
    api_query_url: str
    api_endpoint_params_template: str
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
    baseline: RangeWindow
    comparison: RangeWindow


# -------- Policy: metrics --------
@dataclass
class RegressionPolicy:
    name: str
    # Meaning:
    # - "greater_than": higher is better; violation if value < baseline * threshold
    # - "less_than":    lower  is better; violation if value > baseline * threshold
    # - "equal_to":     value should be ~= baseline * threshold within rel_tol
    condition: Literal["greater_than", "less_than", "equal_to"]
    threshold: float
    rel_tol: float = 1e-3  # used only for "equal_to"

    def is_violation(self, value: float, baseline: float) -> bool:
        target = baseline * self.threshold

        if self.condition == "greater_than":
            # value should be >= target
            return value < target

        if self.condition == "less_than":
            # value should be <= target
            return value > target

        # equal_to: |value - target| should be within rel_tol * max(1, |target|)
        denom = max(1.0, abs(target))
        return abs(value - target) > self.rel_tol * denom

@dataclass
class Policy:
    frequency: Frequency
    range: RangeConfig
    metrics: Dict[str, RegressionPolicy]


# -------- Top-level benchmark regression config --------
@dataclass
class BenchmarkConfig:
    """
        BenchmarkConfig defines the benchmark regression config for a given benchmark.
        source: defines the source of the benchmark data we want to query_params
        policy: defines the policy for the benchmark regressions
        name:  the name of the benchmark
        id:    the id of the benchmark, this must be unique for each benchmark, and cannot be changed once set
    """
    name: str
    id: str
    source: Source
    policy: Policy


@dataclass
class BenchmarkRegressionConfigBook:
    configs: Dict[str, BenchmarkConfig] = field(default_factory=dict)

    def __getitem__(self, key: str) -> BenchmarkConfig:
        config = self.configs.get(key, None)
        if not config:
            raise KeyError(f"Config {key} not found")
        return config
