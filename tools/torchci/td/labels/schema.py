"""The unit row every kind writes, the kinds, and the time conversions the builder uses."""

from datetime import datetime, timezone
from typing import Any


MAIN = "main"
KINDS = (MAIN,)
DAY = 86400

FIELDS = (
    "unit_id",
    "kind",
    "time",
    "sha",
    "pr_number",
    "candidates_month",
    "candidates",
    "positives",
    "observed",
    "single",
    "confirmed",
    "workflow",
    "build_environment",
    "test_config",
    "propensity",
    "train_ok",
)


def unit_row(**fields: Any) -> dict[str, Any]:
    """A unit with every field, None where it does not apply to the kind."""
    unknown = set(fields) - set(FIELDS)
    if unknown:
        raise KeyError(f"unknown unit fields: {sorted(unknown)}")
    return {name: fields.get(name) for name in FIELDS}


def epoch(value: datetime) -> int:
    """Unix seconds of a naive UTC datetime."""
    return int(value.replace(tzinfo=timezone.utc).timestamp())


def sql_time(value: datetime) -> str:
    """A naive UTC datetime as a ClickHouse DateTime parameter."""
    return value.strftime("%Y-%m-%d %H:%M:%S")


def month_of(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")
