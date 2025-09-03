from __future__ import annotations
from dataclasses import dataclass, field, fields
from typing import Any, ClassVar, Dict, Literal, Optional, Set, Type, Union
from datetime import datetime, timedelta
from jinja2 import Environment, Template, meta
import requests
import json


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
        return f"{self.value} {self.unit}"


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
        - "greater_than": higher is better; violation if value < baseline * threshold
        - "less_than":    lower  is better; violation if value > baseline * threshold
        - "equal_to":     value should be ~= baseline * threshold within rel_tol
    """
    name: str
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

class BaseNotificationConfig:
    # every subclass must override this
    type_tag: ClassVar[str]

    @classmethod
    def from_dict(cls: Type[T], d: Dict[str, Any]) -> T:
        # pick only known fields for this dataclass
        kwargs = {f.name: d.get(f.name) for f in fields(cls)}
        return cls(**kwargs)  # type: ignore

    @classmethod
    def matches(cls, d: Dict[str, Any]) -> bool:
        return d.get("type") == cls.type_tag


@dataclass
class GitHubNotificationConfig(BaseNotificationConfig):
    type: str = "github"
    repo: str = ""
    issue_number: str = ""
    type_tag: ClassVar[str] = "github"

    def create_github_comment(self, body: str, github_token: str) -> Dict[str, Any]:
        """
            Create a new comment on a GitHub issue.
            Args:
                notification_config: dict with keys:
                    - type: must be "github"
                    - repo: "owner/repo"
                    - issue: issue number (string or int)
                body: text of the comment
                token: GitHub personal access token or GitHub Actions token

                Returns:
                    The GitHub API response as a dict (JSON).
        """
        url = f"https://api.github.com/repos/{self.repo}/issues/{self.issue_number}/comments"
        headers = {
            "Authorization": f"token {github_token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "bench-reporter/1.0",
        }
        resp = requests.post(url, headers=headers, json={"body": body})
        resp.raise_for_status()
        return resp.json()

@dataclass
class Policy:
    frequency: Frequency
    range: RangeConfig
    metrics: Dict[str, RegressionPolicy]
    notification_config: Optional[Dict[str, Any]] = None

    def get_github_notification_config(self) -> Optional[GitHubNotificationConfig]:
        if not self.notification_config:
            return None
        if self.notification_config and self.notification_config.get("type") == "github":
        return notification_from_dict(self.notification_config)  # type: ignore


# -------- Top-level benchmark regression config --------
@dataclass
class BenchmarkConfig:
    """
    Represents a single benchmark regression configuration.

        - BenchmarkConfig defines the benchmark regression config for a given benchmark.
        - source: defines the source of the benchmark data we want to query
        - policy: defines the policy for the benchmark regressions
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
        config = self.configs.get(key, None)
        if not config:
            raise KeyError(f"Config {key} not found")
        return config
