"""Run test_cost_mv's query (fortesting/000005-test-cost-view.sql) on literal
inputs, so tests can check its occupancy and test-time-ratio arithmetic.

The committed view SQL is read as is; its four sources are swapped for literal
tables built from Python rows (default.workflow_job, ci.runs, ci.tests and
ci.owners), and its window (today() - 3 .. today() + 1) for fixed dates. The
query runs as a plain SELECT on the ClickHouse service that migrate.py uses
(CLICKHOUSE_ENDPOINT, CLICKHOUSE_USERNAME, CLICKHOUSE_PASSWORD); it reads no
real table and writes nothing, so a read-only user is enough.

Times are seconds after BASE, so a scenario reads like a timeline:

    jobs = [Job(1, start=0, end=100)]
    runs = [Run(1, "A", "test_nn.py", 0, 60), Run(1, "B", "test_ops.py", 10, 40)]
    rows = run_view(jobs, runs, owners={"test_nn.py": ["nn"]})
"""

import os
import re
import sys
import unittest
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence


HERE = Path(__file__).resolve().parent
SCHEMA = HERE.parent
VIEW_SQL = SCHEMA / "fortesting" / "000005-test-cost-view.sql"
sys.path.insert(0, str(SCHEMA))
import migrate  # noqa: E402


# Second 0 of every scenario; its day is the window's first day.
BASE = datetime(2026, 11, 1, tzinfo=timezone.utc)
REPO = "pytorch/pytorch"


@dataclass
class Job:
    """A default.workflow_job row. start and end are seconds after BASE."""

    id: int
    start: float
    end: float
    name: str = "linux-jammy-py3.10 / test (default, 1, 1, linux.2xlarge)"
    workflow: str = "pull"
    repo: str = REPO
    status: str = "completed"
    conclusion: str = "success"
    runner: str = "runner-1"
    # The runner labels the job asked for; the view sorts and joins them with ','.
    labels: List[str] = field(default_factory=lambda: ["linux.2xlarge"])
    # Defaults to start; later than start marks a rerun with a stale start.
    created: Optional[float] = None
    # Higher wins when a job id appears more than once (newer version).
    version: int = 0


@dataclass
class Run:
    """A ci.runs row: one attempt of one test in one report (process)."""

    job: int
    report: str  # any label; one report_uuid per (job, label)
    file: str
    start: float
    end: float
    outcome: str = "passed"
    case: str = ""  # tells apart tests of one file; defaults to a fresh case
    suite: str = ""  # the gtest suite for C++ tests
    language: str = "python"
    env: int = 1  # ci.environments.id


@dataclass
class Scenario:
    jobs: Sequence[Job]
    runs: Sequence[Run] = ()
    owners: Dict[str, List[str]] = field(default_factory=dict)
    day_from: str = "2026-11-01"
    day_to: str = "2026-11-02"
    # The first day ci.runs holds in full; the view computes no earlier day.
    retention_floor: str = "1970-01-01"


def _ts(seconds: float) -> str:
    """A DateTime64(3) literal."""
    return (BASE + timedelta(seconds=seconds)).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _ts_s(seconds: float) -> str:
    """A DateTime literal: workflow_job keeps whole seconds."""
    return (BASE + timedelta(seconds=round(seconds))).strftime("%Y-%m-%d %H:%M:%S")


def _lit(value) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_lit(v) for v in value) + "]"
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _values(structure: str, rows: List[tuple], empty_row: tuple) -> str:
    """A literal table; values() needs a row, so an empty one is a typed row
    filtered out."""
    body = ", ".join(
        "(" + ", ".join(_lit(v) for v in row) + ")" for row in rows or [empty_row]
    )
    limit = "" if rows else " LIMIT 0"
    return f"SELECT * FROM values('{structure}', {body}){limit}"


def sources(scenario: Scenario) -> Dict[str, str]:
    jobs = [
        (
            j.id,
            j.repo,
            j.workflow,
            list(j.labels),
            j.name,
            j.status,
            j.conclusion,
            j.runner,
            _ts_s(j.start if j.created is None else j.created),
            _ts_s(j.start),
            _ts_s(j.end),
            _ts(j.version),
        )
        for j in scenario.jobs
    ]
    report_ids: Dict[tuple, str] = {}
    test_ids: Dict[tuple, int] = {}
    runs, tests = [], []
    for i, r in enumerate(scenario.runs):
        report = report_ids.setdefault(
            (r.job, r.report), str(uuid.UUID(int=len(report_ids) + 1))
        )
        key = (r.file, r.suite, r.language, r.case or f"case{i}")
        if key not in test_ids:
            test_ids[key] = len(test_ids) + 1
            tests.append((test_ids[key], r.file, r.suite, r.language))
        runs.append(
            (r.job, report, test_ids[key], r.env, r.outcome, _ts(r.start), _ts(r.end))
        )
    owners = [(REPO, f, o) for f, o in scenario.owners.items()]
    return {
        "workflow_job": _values(
            "id Int64, repository_full_name String, workflow_name String, labels Array(String), "
            "name String, status String, "
            "conclusion String, runner_name String, created_at DateTime, started_at DateTime, "
            "completed_at DateTime, _inserted_at DateTime64(3)",
            jobs,
            (0, "", "", [], "", "", "", "", _ts_s(0), _ts_s(0), _ts_s(0), _ts(0)),
        ),
        "runs": _values(
            "github_workflow_job_id Int64, report_uuid UUID, tests_id UInt64, environments_id UInt64, "
            "outcome String, started_at DateTime64(3), ended_at DateTime64(3)",
            runs,
            (0, str(uuid.UUID(int=0)), 0, 0, "", _ts(0), _ts(0)),
        ),
        "tests": _values(
            "id UInt64, file String, suite String, language String",
            tests,
            (0, "", "", ""),
        ),
        "owners": _values(
            "repo String, file String, owners Array(String)", owners, ("", "", [])
        ),
    }


# (pattern, replacement key, occurrences in the committed SQL)
REWRITES = [
    (
        "(SELECT toDate(min(started_at)) + 1 FROM ci.runs)",
        "toDate('{retention_floor}')",
        1,
    ),
    ("FROM default.workflow_job\n", "FROM ({workflow_job})\n", 1),
    ("FROM ci.runs AS r FINAL\n", "FROM ({runs}) AS r\n", 1),
    ("FROM ci.tests FINAL)", "FROM ({tests}))", 1),
    ("FROM ci.owners FINAL\n", "FROM ({owners})\n", 1),
    ("today() - 3", "toDate('{day_from}')", 2),
    ("today() + 1", "toDate('{day_to}')", 2),
]


def view_select() -> str:
    """The view's SELECT, without its CREATE header and final SETTINGS."""
    sql = VIEW_SQL.read_text()
    select = sql[sql.index("\nAS\nWITH\n") + len("\nAS\n") :]
    select = re.sub(r"\nSETTINGS join_use_nulls[\s\S]*$", "", select)
    return select


def scenario_sql(scenario: Scenario) -> str:
    sql = view_select()
    params = dict(
        sources(scenario),
        day_from=scenario.day_from,
        day_to=scenario.day_to,
        retention_floor=scenario.retention_floor,
    )
    for pattern, replacement, count in REWRITES:
        found = sql.count(pattern)
        if found != count:
            raise AssertionError(
                f"{VIEW_SQL.name}: expected {count} of {pattern!r}, found {found}; update REWRITES"
            )
        sql = sql.replace(pattern, replacement.format(**params))
    return sql


# Literal inputs of CI-sized scenarios exceed ClickHouse's default
# max_query_size (256 KiB); it can only be raised outside the query.
MAX_QUERY_SIZE = 8_000_000


def view_query(scenario: Scenario) -> str:
    """The SELECT run_scenario sends: the view's rows, ordered by (workflow,
    file, module, environment), without computed_at."""
    return (
        "SELECT * EXCEPT computed_at FROM (\n" + scenario_sql(scenario) + "\n)\n"
        "ORDER BY workflow_name, test_file, test_module, environments_id\n"
        "SETTINGS join_use_nulls = 0, max_threads = 2, max_execution_time = 120\n"
        "FORMAT JSONEachRow"
    )


def run_scenario(scenario: Scenario) -> List[dict]:
    """test_cost rows the view would write for this scenario; seconds as
    floats."""
    executor = migrate.Http("default")
    executor.url += f"&max_query_size={MAX_QUERY_SIZE}"
    rows = migrate.rows_of(executor, view_query(scenario))
    for row in rows:
        for key, value in row.items():
            if key.endswith("_seconds"):
                row[key] = float(value)
        row["environments_id"] = int(row["environments_id"])
    return rows


def run_view(
    jobs: Sequence[Job],
    runs: Sequence[Run] = (),
    owners: Optional[Dict[str, List[str]]] = None,
    day_from: str = "2026-11-01",
    day_to: str = "2026-11-02",
    retention_floor: str = "1970-01-01",
) -> List[dict]:
    """run_scenario for a scenario given as its parts."""
    return run_scenario(
        Scenario(jobs, runs, owners or {}, day_from, day_to, retention_floor)
    )


class ClickHouseTestCase(unittest.TestCase):
    """Skipped unless the ClickHouse service is configured."""

    @classmethod
    def setUpClass(cls):
        if not os.environ.get("CLICKHOUSE_ENDPOINT"):
            raise unittest.SkipTest(
                "set CLICKHOUSE_ENDPOINT, CLICKHOUSE_USERNAME and CLICKHOUSE_PASSWORD"
            )


def by_file(rows: List[dict]) -> Dict[str, dict]:
    """Rows keyed by test_file (module appended as file::module when set)."""
    out = {}
    for row in rows:
        key = row["test_file"] + (
            f"::{row['test_module']}" if row["test_module"] else ""
        )
        if key in out:
            raise AssertionError(
                f"two rows for {key}; key by workflow or environment too"
            )
        out[key] = row
    return out
