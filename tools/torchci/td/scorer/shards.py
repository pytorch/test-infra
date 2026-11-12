"""Day shards: every TD-on PR job of one UTC day with its TD log's scores and its outcomes.

A shard holds one `run` record per PR workflow run whose TD job succeeded (its TD log's
scores, raised heuristics, changed files and aggregated scores) and one `unit` record per
TD-on (run, build environment, test config): the files that ran, the files TD excluded,
the failed files, the files that are neither failed nor passed, and the failed files that
also failed in that config on main that day.

A file failed when, at its latest attempt, it had a real failure (not rerun-only) in a job
that concluded `failure` with at most MAX_FAILING_FILES failing files. A file that failed
in any other way (rerun-only, passed at a later attempt of the same job, or in a job past
the cap or not concluded `failure`) is neither. Training rows (rows.py) and gate events
(gate.py) are derived from shards.

A shard is healthy when no fetch failed, at most MAX_MISSING_LOGS of its TD-on runs lack a
parsable TD log, and it has units whenever it has TD-on runs; only healthy days are stored
and used. An unhealthy day is permanent when a rebuild would find the same: its missing
logs are 404s, or its parsed logs' runs have no outcome rows at all.
"""

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Callable, Optional, TypeVar

import requests
from torchci.td.llm.events import _query
from torchci.td.scorer.logs import (
    fetch_td_log_found,
    http_get,
    map_threaded,
    RAW_BUCKET_URL,
)
from torchci.td.scorer.rows_sql import (
    MAIN_FAILURES_SQL,
    NOT_A_FILE,
    RUNS_SQL,
    UNITS_SQL,
)


logger = logging.getLogger(__name__)
T = TypeVar("T")

EXCLUSIONS_URL = RAW_BUCKET_URL + "/additional_info/td_exclusions/{run_id}/{attempt}"
MAX_ATTEMPTS = 5
NO_TD_BUILD_MARKERS = ("macos", "xpu", "onnx")
MAX_FAILING_FILES = 20
MAX_MISSING_LOGS = 0.15
# tests.all_test_runs' inserts start at 2025-11-05 17:00 UTC; TD logs and td_exclusions
# exist before that.
FIRST_DATA_DAY = date(2025, 11, 6)


@dataclass(frozen=True)
class Run:
    run_id: int
    pr: int
    head_sha: str
    created_at: str
    heuristics: list[str]
    raised: list[str]
    scores: dict[str, dict[str, float]]
    changed_files: Optional[list[str]]
    aggregated: dict[str, float]


@dataclass(frozen=True)
class Unit:
    run_id: int
    build_env: str
    test_config: str
    ran: list[str]
    excluded: list[str]
    failed: list[str]
    neither: list[str]
    main_broken: list[str]


@dataclass
class DayShard:
    day: str
    runs: list[Run] = field(default_factory=list)
    units: list[Unit] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def _over(self, key: str) -> bool:
        return self.meta.get(key, 0) > MAX_MISSING_LOGS * self.meta.get("td_on_runs", 0)

    @property
    def fetched(self) -> bool:
        return self.meta.get("errors", 0) == 0

    @property
    def has_outcomes(self) -> bool:
        return not (self.meta.get("td_on_runs", 0) > 0 and not self.units)

    @property
    def healthy(self) -> bool:
        return self.fetched and self.has_outcomes and not self._over("logs_missing")

    @property
    def no_outcomes(self) -> bool:
        """It had parsed TD logs, and the outcome query found no unit at all for them."""
        return (
            self.meta.get("logs_parsed", 0) > 0 and self.meta.get("units_seen", 0) == 0
        )

    @property
    def logs_gap(self) -> bool:
        """Unhealthy only through missing or unparsable TD logs, all of them included."""
        all_missing = self.meta.get("logs_parsed", 0) == 0
        return (
            self.fetched
            and self._over("logs_missing")
            and (self.has_outcomes or all_missing)
        )

    @property
    def permanent(self) -> bool:
        """Unhealthy in a way every later build repeats: no fetch failed, and more than
        MAX_MISSING_LOGS of its TD-on runs' logs are 404s, or no_outcomes."""
        return (
            not self.healthy
            and self.fetched
            and (self._over("logs_404") or self.no_outcomes)
        )


QUERY_RETRIES = 3
# HUD's ClickHouse user has a concurrent-query limit (error 202); a network failure
# surfaces as OperationalError. Both pass on a later attempt.
TRANSIENT = ("(code 202)", "OperationalError")


def query(name: str, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    for attempt in range(QUERY_RETRIES):
        try:
            return _query(name, sql, params)
        except RuntimeError as e:
            if attempt == QUERY_RETRIES - 1 or not any(t in str(e) for t in TRANSIENT):
                raise
            logger.warning("%s, retrying", e)
            time.sleep(30 * (attempt + 1))
    raise AssertionError("unreachable")


def td_platform(build_env: str) -> bool:
    return not any(m in build_env for m in NO_TD_BUILD_MARKERS)


def ch_day(day: date) -> dict[str, str]:
    return {
        "start": f"{day.isoformat()} 00:00:00.000",
        "stop": f"{(day + timedelta(days=1)).isoformat()} 00:00:00.000",
    }


def fetch_exclusions(run_id: int, attempts: int) -> dict[tuple[str, str], set[str]]:
    """TD's excluded files per (build env, test config), over the run's attempts."""
    out: dict[tuple[str, str], set[str]] = {}
    for attempt in range(1, min(attempts, MAX_ATTEMPTS) + 1):
        body = http_get(EXCLUSIONS_URL.format(run_id=run_id, attempt=attempt))
        if body is None:
            continue
        try:
            data = json.loads(body)
        except ValueError as e:
            logger.warning(
                "run %s attempt %s: bad td_exclusions: %s", run_id, attempt, e
            )
            continue
        if not isinstance(data, dict):
            continue
        for env, configs in data.items():
            for config, tests in (configs if isinstance(configs, dict) else {}).items():
                if isinstance(tests, list):
                    files = {str(t) for t in tests} - set(NOT_A_FILE)
                    out.setdefault((env, config), set()).update(files)
    return {k: v for k, v in out.items() if v}


def fetch_all(
    func: Callable[[dict[str, Any]], T], items: list[dict[str, Any]]
) -> tuple[list[Optional[T]], int]:
    """func over items, None for an item whose fetch raised; and how many raised."""

    def one(item: dict[str, Any]) -> tuple[Optional[T], bool]:
        try:
            return func(item), False
        except (requests.RequestException, OSError, EOFError) as e:
            logger.error("fetch failed for %s: %r", item, e, exc_info=True)
            return None, True

    results = map_threaded(one, items)
    return [r for r, _ in results], sum(failed for _, failed in results)


def build_day_shard(day: date) -> DayShard:
    started = datetime.now()
    runs = query("td_scorer_runs", RUNS_SQL, ch_day(day))
    exclusions, exclusion_errors = fetch_all(
        lambda r: fetch_exclusions(int(r["run_id"]), int(r["attempts"])), runs
    )
    td_on = {int(r["run_id"]): x for r, x in zip(runs, exclusions) if x}
    runs = [r for r in runs if int(r["run_id"]) in td_on]
    found, log_errors = fetch_all(
        lambda r: fetch_td_log_found(int(r["td_job_id"])), runs
    )
    fetched = datetime.now()
    logs = [x[0] if x else None for x in found]
    by_run = {int(r["run_id"]): (r, log) for r, log in zip(runs, logs) if log}
    params = {
        "runs": sorted(by_run),
        "shas": sorted({r["head_sha"] for r in runs}),
        "max_failing": MAX_FAILING_FILES,
    }
    unit_rows = query("td_scorer_units", UNITS_SQL, params) if by_run else []
    main_failed: dict[tuple[str, str], set[str]] = {}
    for row in query("td_scorer_main_failures", MAIN_FAILURES_SQL, ch_day(day)):
        key = (row["build_env"], row["test_config"])
        main_failed.setdefault(key, set()).add(row["test_file"])
    shard = DayShard(day=day.isoformat())
    for row in unit_rows:
        run_id, key = int(row["run_id"]), (row["build_env"], row["test_config"])
        excluded = td_on.get(run_id, {}).get(key)
        if run_id not in by_run or not excluded or not td_platform(key[0]):
            continue
        failed = sorted(row["failed"])
        shard.units.append(
            Unit(
                run_id=run_id,
                build_env=key[0],
                test_config=key[1],
                ran=sorted(row["ran"]),
                excluded=sorted(excluded),
                failed=failed,
                neither=sorted(row["neither"]),
                main_broken=sorted(set(failed) & main_failed.get(key, set())),
            )
        )
    kept = {u.run_id for u in shard.units}
    for run_id in sorted(kept):
        row, log = by_run[run_id]
        shard.runs.append(
            Run(
                run_id=run_id,
                pr=int(row["pr"]),
                head_sha=row["head_sha"],
                created_at=str(row["created_at"])[:19],
                heuristics=list(log.heuristics),
                raised=list(log.raised),
                scores=log.scores,
                changed_files=(
                    list(log.changed_files) if log.changed_files is not None else None
                ),
                aggregated=log.aggregated,
            )
        )
    shard.meta = {
        "pr_runs_td_ok": len(exclusions),
        "td_on_runs": len(td_on),
        "logs_parsed": len(by_run),
        "logs_missing": len(runs) - len(by_run),
        "logs_404": sum(x is not None and not x[1] for x in found),
        "errors": exclusion_errors + log_errors,
        "units_seen": len(unit_rows),
        "units": len(shard.units),
        "runs": len(shard.runs),
        "fetch_seconds": round((fetched - started).total_seconds(), 1),
        "build_seconds": round((datetime.now() - started).total_seconds(), 1),
    }
    logger.info("day %s: %s", shard.day, shard.meta)
    return shard
