from __future__ import annotations

import dataclasses
import json
import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, ClassVar, Dict, Literal, Optional

import requests
from jinja2 import Environment, meta, Template


logger = logging.getLogger(__name__)


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

    def to_timedelta_s(self) -> int:
        return int(self.to_timedelta().total_seconds())

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

    def total_timedelta_s(self) -> int:
        return int(
            timedelta(days=self.baseline.value + self.comparison.value).total_seconds()
        )

    def comparison_timedelta(self) -> timedelta:
        return timedelta(days=self.comparison.value)

    def comparison_timedelta_s(self) -> int:
        return int(self.comparison_timedelta().total_seconds())

    def baseline_timedelta(self) -> timedelta:
        return timedelta(days=self.baseline.value)

    def baseline_timedelta_s(self) -> int:
        return int(self.baseline_timedelta().total_seconds())


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
    baseline_aggregation: Literal["max", "min", "latest", "earliest"] = "max"
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
class BaseNotificationConfig:
    # subclasses override this
    type_tag: ClassVar[str] = ""

    @classmethod
    def matches(cls, d: Dict[str, Any]) -> bool:
        return d.get("type") == cls.type_tag


@dataclass
class NotificationCondition:
    # subclasses override this
    type: str = "all"
    device_arches: Optional[list[dict[str, str]]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "NotificationCondition":
        return cls(
            type=d.get("type", "all"),
            device_arches=d.get("device_arches", None),
        )

    def match_condition(self, detail_list: list[Dict[str, str]]) -> bool:
        """
        Check if any {device, arch} dict in detail_list matches any combo in device_arches.

        Args:
            detail_list: List of {"device": ..., "arch": ...} dicts to check

        Returns:
            True if at least one pair from detail_list matches any combo in device_arches
        """
        if self.type == "all":
            return True

        if not detail_list or len(detail_list) == 0:
            return False

        if self.type == "device_arch":
            # return not match if device_arches is none or empty
            if not self.device_arches:
                return False
            for item in detail_list:
                device = item.get("device", "")
                arch = item.get("arch", "")
                for condition in self.device_arches:
                    cond_device = condition.get("device", "")
                    cond_arch = condition.get("arch", "")
                    device_matches = not cond_device or cond_device == device
                    arch_matches = not cond_arch or cond_arch == arch
                    if device_matches and arch_matches:
                        return True
        return False


@dataclass
class GitHubNotificationConfig(BaseNotificationConfig):
    type_tag: ClassVar[str] = "github"

    # actual fields
    type: str = "github"
    repo: str = ""  # e.g. "owner/repo"
    issue_number: str = ""  # store as str for simplicity
    condition: Optional[NotificationCondition] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitHubNotificationConfig":
        # support 'issue' alias
        issue = d.get("issue_number") or d.get("issue") or ""
        return cls(
            type="github",
            repo=d.get("repo", ""),
            issue_number=str(issue),
            condition=NotificationCondition.from_dict(d.get("condition", {})),
        )

    def create_github_comment(self, body: str, github_token: str) -> Dict[str, Any]:
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
    frequency: "Frequency"
    range: "RangeConfig"
    metrics: Dict[str, "RegressionPolicy"]

    notification_config: Optional[dict[str, Any]] = None

    def get_github_notification_configs(self) -> list[GitHubNotificationConfig]:
        if not self.notification_config or not self.notification_config.get("configs"):
            return []

        results = []
        for config in self.notification_config.get("configs"):
            if not config.get("type"):
                continue
            if config.get("type") == "github":
                results.append(GitHubNotificationConfig.from_dict(config))
        return results


ReportSeverity = Literal[
    "none",
    "no_regression",
    "insufficient_data",
    "suspicious",
    "regression",
    "unknown",
]


# Mapping from severity label → numeric level.
# Higher numbers mean more severe, used to compare and filter results before DB upload.
#
# Effects on DB upload:
# - "unknown": (-1) fallback for invalid input → excluded from DB
# - "none": (0) no report generated → results field is empty, nothing uploaded
# - "no_regression": (1) clean report → all results with severity >= 1 are uploaded
# - "insufficient_data": (2) weak signal → uploaded, also includes suspicious/regression
# - "suspicious": (3) medium signal → uploaded, also includes regression
# - "regression": (4) strongest severity → always uploaded
#
# This allows filtering: e.g., if threshold = 2, DB upload includes
# "insufficient_data", "suspicious", and "regression" but not "none" or "no_regression".
SEVERITY_ORDER: dict[ReportSeverity, int] = {
    "unknown": -1,  # fallback (bad/invalid input)
    "none": 0,  # no report generated, leads to no details uploaded to db in field results
    "no_regression": 1,  # no regression, leads to includes all the data with same/higher severity
    "insufficient_data": 2,  # weak signal
    "suspicious": 3,  # medium signal
    "regression": 4,  # strongest severity
}


@dataclass
class ReportConfig:
    """
    decide what to include in db summary report
    report_level: lowest level of regression to store in db
    """

    report_level: ReportSeverity = "regression"

    def get_severity_map(self) -> dict[ReportSeverity, int]:
        # shadow copy is safe since this is a flat dict.
        return SEVERITY_ORDER.copy()

    def get_order(self) -> int:
        return self.get_severity_map().get(self.report_level, -1)


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
    hud_info: Optional[dict[str, Any]] = None
    report_config: ReportConfig = field(default_factory=ReportConfig)


@dataclass
class BenchmarkRegressionConfigBook:
    configs: Dict[str, BenchmarkConfig] = field(default_factory=dict)

    def __getitem__(self, key: str) -> BenchmarkConfig:
        config = self.configs.get(key)
        if not config:
            raise KeyError(f"Config {key} not found")
        return config


def to_dict(x: Any) -> Any:
    if dataclasses.is_dataclass(x):
        return {f.name: to_dict(getattr(x, f.name)) for f in dataclasses.fields(x)}
    if isinstance(x, dict):
        return {k: to_dict(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set)):
        return [to_dict(v) for v in x]
    return x  # primitive or already JSON-serializable
