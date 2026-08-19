"""Configuration for the advisor-coverage dispatcher.

Reads configuration from environment variables (Lambda env / EventBridge) with
optional per-invocation overrides from the event payload. Event overrides use
lowercase field-name keys (the autorevert convention). Mirrors the env var
names used by the sibling pytorch-auto-revert lambda so the two share the same
Secrets Manager secret, ClickHouse user, and GitHub App.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from pytorch_auto_revert.utils import parse_datetime


# The coverage prefix is a SECURITY INVARIANT, not a tunable. A coverage verdict
# carries signal_key = COVERAGE_SIGNAL_KEY_PREFIX + <real job key>; the prefix
# keeps it out of autorevert's exact-match verdict read-back, so it can never
# drive a real revert or veto. It is deliberately NOT env/event configurable: an
# empty or altered prefix would land verdicts on native keys and trigger real
# reverts. The same literal is stripped by the `'^coverage_'` regex in the
# advisor_agg CTE of torchci's flaky_trunk query.sql files (flaky_trunk_jobs,
# flaky_trunk_timeseries, flaky_trunk_entity_runs, flaky_trunk_runner_labels),
# which is what normalizes a coverage verdict onto the native job so it
# classifies the red on /flaky_trunk; this literal MUST stay equal to that regex.
COVERAGE_SIGNAL_KEY_PREFIX = "coverage_"

# Compiled-in safety ceilings. Env/event may only make the throttle SMALLER.
HARD_CAP_DISPATCHES = 100
MIN_DISPATCH_GAP_SECONDS = 1
# The Lambda's configured timeout (tf). The throttle is clamped so a run's
# inter-dispatch sleeps can never approach it.
LAMBDA_TIMEOUT_SECONDS = 260
# Wall-clock budget for one backfill invocation; leaves margin for the final
# chunk + response so the Lambda returns a resume cursor instead of timing out.
BACKFILL_WALL_CLOCK_BUDGET_SECONDS = 220

# Dispatch is only ever aimed at these repos; an event cannot redirect it.
ALLOWED_REPOS = frozenset({"pytorch/pytorch"})

# S3 raw-log bucket used for the log-readability pre-filter.
S3_LOG_BUCKET = "ossci-raw-job-status"
# Logs smaller than this (or missing) are stubs — skip, don't dispatch on them.
MIN_LOG_BYTES = 1000
# Green baseline-before commits to include in the isolated-red payload.
BASELINE_GREEN_COMMITS = 3

DEFAULT_MAX_DISPATCHES_PER_RUN = 10
DEFAULT_DISPATCH_GAP_SECONDS = 3
DEFAULT_HOURS = 24
# Backfill enumeration chunk size (a day gives persistence enough neighbors).
DEFAULT_AS_OF_STEP_HOURS = 24
# Minimum total runs for a job to be enumerated — matches the /flaky_trunk page's
# HAVING total_runs >= minRuns so coverage targets the SAME displayed set.
DEFAULT_MIN_RUNS = 20
# Persistence lookback/lookahead margin: the enumeration window is widened by
# this on each side so the lag/lead persistence check sees the neighbouring
# trunk commits of reds at the emit-window edges (reds are then emitted only
# within the core window). A few hours covers many trunk commits.
PERSISTENCE_MARGIN_HOURS = 6
ADVISOR_WORKFLOW_FILE = "claude-autorevert-advisor.yml"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"Env var {name}={raw!r} is not a valid integer") from e


def _parse_workflows(value: Any) -> List[str]:
    """Parse a workflows filter from a JSON-array string, a real list, or CSV.

    Terraform passes `WORKFLOWS = jsonencode([...])` (a JSON-array *string*); an
    event may pass a real list or a string. Empty means "all trunk workflows"
    (the coverage target is every unclassified red, not autorevert's subset).
    """
    if isinstance(value, list):
        return [str(w) for w in value]
    if not isinstance(value, str) or not value.strip():
        return []
    s = value.strip()
    try:
        parsed = json.loads(s)
        if isinstance(parsed, list):
            return [str(w) for w in parsed]
    except (ValueError, TypeError):
        pass
    return [w.strip() for w in s.split(",") if w.strip()]


def _parse_optional_dt(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    return parse_datetime(raw)


@dataclass
class CoverageConfig:
    """All settings needed to run one coverage dispatch invocation."""

    clickhouse_host: str = "localhost"
    clickhouse_port: int = 8443
    clickhouse_username: str = ""
    clickhouse_password: str = ""
    clickhouse_database: str = "default"

    github_app_id: str = ""
    github_app_secret: str = ""
    github_installation_id: int = 0
    github_access_token: str = ""
    secret_store_name: str = ""

    repo_full_name: str = "pytorch/pytorch"
    # Empty = all trunk workflows; a non-empty list filters the enumeration.
    workflows: List[str] = field(default_factory=list)
    hours: int = DEFAULT_HOURS
    min_runs: int = DEFAULT_MIN_RUNS

    max_dispatches_per_run: int = DEFAULT_MAX_DISPATCHES_PER_RUN
    dispatch_gap_seconds: int = DEFAULT_DISPATCH_GAP_SECONDS

    mode: str = "ongoing"  # "ongoing" | "backfill"
    as_of_start: Optional[datetime] = None
    as_of_end: Optional[datetime] = None
    as_of_step_hours: int = DEFAULT_AS_OF_STEP_HOURS

    dry_run: bool = True
    log_level: str = "INFO"

    def effective_gap_seconds(self) -> int:
        """Gap floored to a positive minimum (never 0 → no dispatch storm)."""
        return max(MIN_DISPATCH_GAP_SECONDS, int(self.dispatch_gap_seconds))

    def effective_max_dispatches(self) -> int:
        """Configured cap, clamped by HARD_CAP and the Lambda timeout budget.

        Keeps the whole run's inter-dispatch sleeps under the timeout:
        (n-1) * gap < LAMBDA_TIMEOUT_SECONDS.
        """
        gap = self.effective_gap_seconds()
        timeout_cap = (LAMBDA_TIMEOUT_SECONDS - 1) // gap + 1
        return max(
            1,
            min(int(self.max_dispatches_per_run), HARD_CAP_DISPATCHES, timeout_cap),
        )

    def _validate(self, *, require_backfill_window: bool = False) -> "CoverageConfig":
        if self.repo_full_name not in ALLOWED_REPOS:
            raise ValueError(
                f"repo_full_name {self.repo_full_name!r} is not in the allowlist "
                f"{sorted(ALLOWED_REPOS)} — refusing to dispatch against it"
            )
        if self.mode not in ("ongoing", "backfill"):
            raise ValueError(f"mode must be 'ongoing' or 'backfill', got {self.mode!r}")
        if require_backfill_window and self.mode == "backfill":
            if self.as_of_start is None or self.as_of_end is None:
                raise ValueError(
                    "backfill mode requires as_of_start and as_of_end "
                    "(set AS_OF_START / AS_OF_END env or the event fields)"
                )
            if self.as_of_start > self.as_of_end:
                raise ValueError(
                    f"as_of_start ({self.as_of_start}) must be <= "
                    f"as_of_end ({self.as_of_end})"
                )
        return self

    @classmethod
    def from_env(cls) -> "CoverageConfig":
        """Build a config purely from environment variables."""
        config = cls(
            clickhouse_host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
            clickhouse_port=_env_int("CLICKHOUSE_PORT", 8443),
            clickhouse_username=os.environ.get("CLICKHOUSE_USERNAME", ""),
            clickhouse_password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
            clickhouse_database=os.environ.get("CLICKHOUSE_DATABASE", "default"),
            github_app_id=os.environ.get("GITHUB_APP_ID", ""),
            github_app_secret=os.environ.get("GITHUB_APP_SECRET", ""),
            github_installation_id=_env_int("GITHUB_INSTALLATION_ID", 0),
            github_access_token=os.environ.get("GITHUB_TOKEN", ""),
            secret_store_name=os.environ.get("SECRET_STORE_NAME", ""),
            repo_full_name=os.environ.get("REPO_FULL_NAME", "pytorch/pytorch"),
            workflows=_parse_workflows(os.environ.get("WORKFLOWS", "")),
            hours=_env_int("HOURS", DEFAULT_HOURS),
            min_runs=_env_int("MIN_RUNS", DEFAULT_MIN_RUNS),
            max_dispatches_per_run=_env_int(
                "MAX_DISPATCHES_PER_RUN", DEFAULT_MAX_DISPATCHES_PER_RUN
            ),
            dispatch_gap_seconds=_env_int(
                "DISPATCH_GAP_SECONDS", DEFAULT_DISPATCH_GAP_SECONDS
            ),
            mode=os.environ.get("MODE", "ongoing"),
            as_of_start=_parse_optional_dt(os.environ.get("AS_OF_START")),
            as_of_end=_parse_optional_dt(os.environ.get("AS_OF_END")),
            as_of_step_hours=_env_int("AS_OF_STEP_HOURS", DEFAULT_AS_OF_STEP_HOURS),
            dry_run=_env_bool("DRY_RUN", True),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
        )
        return config._validate()

    @classmethod
    def from_env_and_event(cls, event: Dict[str, Any]) -> "CoverageConfig":
        """Build from env, then apply per-invocation overrides from the event.

        Event keys are the lowercase config field names. `dry_run` can only be
        *re-enabled* via the event (never disabled) — only the Lambda env can
        arm real dispatch, so a stray manual invoke can never start POSTing.
        The coverage prefix, secrets, and CH/GH connection settings are NOT
        event-overridable.
        """
        config = cls.from_env()
        if not event:
            return config

        overrides = {
            "repo_full_name": ("repo_full_name", str),
            "hours": ("hours", int),
            "min_runs": ("min_runs", int),
            "max_dispatches_per_run": ("max_dispatches_per_run", int),
            "dispatch_gap_seconds": ("dispatch_gap_seconds", int),
            "mode": ("mode", str),
            "as_of_step_hours": ("as_of_step_hours", int),
            "log_level": ("log_level", str),
        }
        for attr, (key, caster) in overrides.items():
            if key in event and event[key] is not None:
                setattr(config, attr, caster(event[key]))

        if event.get("workflows") is not None:
            config.workflows = _parse_workflows(event["workflows"])
        if event.get("as_of_start"):
            config.as_of_start = _parse_optional_dt(event["as_of_start"])
        if event.get("as_of_end"):
            config.as_of_end = _parse_optional_dt(event["as_of_end"])
        if event.get("dry_run") is True:
            config.dry_run = True

        return config._validate(require_backfill_window=True)
