#!/usr/bin/env python3
"""Time the test hub's queries and report what each one costs.

    python3 test_performance.py                 # windows of 1, 7, 14 and 30 days, 3 timed runs each
    python3 test_performance.py --window-days 7 --rounds 5 --search softmax

Connection comes from ../migrate.py (the CLICKHOUSE_* variables), and queries
run in its sandbox database, fortesting. The tables must be populated
(populate_dummy_data.py).

The queries run on runs and its catalogs (tests, environments, flags, owners)
and follow the hub prototype (test-infra PR #8660) and the pages planned
after it. From the prototype: the test list page with its health metrics over
a window (runs, passes, failures, skips, average duration, failure rate,
health bucket and last run), the same page with a search, its next page
through the keyset cursor the prototype pages with, and the test detail
page's metrics and newest attempts. Planned pages: the list restricted to one
platform or to trunk jobs, the flaky tests, the tests that got slower, the
tests that appeared or disappeared, where a test runs and its history in one
configuration, the file, owner and job pages, the failure messages of a file,
the time spent per file, and the health of every environment. The queries
that depend on the window run once per --window-days value; the others run
once, over a fixed window named in the output (the prototype's 7-day window
for the list-like ones). The data holds at most 14 days (the TTL), so longer
windows read all of it. Parameters (the anchor time, a test, its busiest
environment and flag set, the environment's accelerator, where the first list
page ends, the week's job ids, a job, a file, an owner) are taken from the
data, so the same script runs on any populate.

For every query: EXPLAIN ESTIMATE (rows and marks runs will read), then
--rounds timed runs, reporting the server's own elapsed time and the rows and
bytes it read, from the X-ClickHouse-Summary header. The output is a setup
block, one block per query with the median, the individual times and what was
read, then a summary table grouped by query with one row per window, and a
line naming the slowest queries. Times are seconds.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from migrate import Failed, Http, SANDBOX  # noqa: E402


DEFAULT_WINDOWS = (1, 7, 14, 30)  # days before the newest row
PROTOTYPE_WINDOW = 7  # days: the window the prototype's list page aggregates over
TTL_DAYS = 14  # days the runs tables keep, so the longest window there is
PAGE = 101  # the prototype fetches one row more than its page of 100 tests
RUNS_PAGE = 21  # and one more than its page of 20 attempts
BAD = "outcome IN ('failed', 'error', 'crashed', 'timed_out')"
MS = "dateDiff('millisecond', started_at, ended_at)"
RERUN_DISABLED = (
    "PYTORCH_TEST_RERUN_DISABLED_TESTS"  # its repeats are not reruns after a failure
)
ENV_COLUMNS = (
    "os, os_version, cpu_architecture, cpu_capability, python_version, cc_compiler, "
    "cc_compiler_version, accelerator, accelerator_version, device_name, device_count"
)
TEST_COLUMNS = "repo, file, suite, case_name, declared_case_name, language"
NEWEST_OWNERS = "SELECT repo, file, argMax(owners, created_at) AS owners FROM owners GROUP BY repo, file"

# The list page's per-test metrics, as the prototype's distinct_tests query
# computes them, the columns derived from them, and the order the page returns
# them in (the prototype's default sort, slowest first).
LIST_METRICS = (
    f"count() AS runs, countIf(outcome = 'passed') AS passed, countIf({BAD}) AS failed, "
    "countIf(outcome = 'skipped') AS skipped, "
    f"sumIf({MS}, outcome = 'passed') AS passed_ms, max(started_at) AS last_run"
)
LIST_DERIVED = (
    "runs, passed, failed, skipped, if(passed > 0, passed_ms / passed, 0) AS avg_ms, "
    "if(runs - skipped > 0, intDiv(failed * 1000000, runs - skipped), 0) AS failure_rate_ppm, "
    "multiIf(runs - skipped > 0, 0, skipped > 0, 1, 2) AS health_sort_bucket, last_run"
)
LIST_COLUMNS = (
    "file",
    "suite",
    "case_name",
    "runs",
    "passed",
    "failed",
    "skipped",
    "avg_ms",
    "failure_rate_ppm",
    "health_sort_bucket",
    "last_run",
)
LIST_ORDER = f"ORDER BY avg_ms DESC, file, suite, case_name LIMIT {PAGE}"


def sql_str(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def window_sql(anchor: str, days: int) -> str:
    return f"started_at > {anchor} - INTERVAL {days} DAY AND started_at <= {anchor}"


def list_page(window: str, extra_where: str = "", page_after: str = "") -> str:
    """The list page: the metrics per test_id from runs, then the names from tests."""
    return (
        f"SELECT t.file AS file, t.suite AS suite, t.case_name AS case_name, {LIST_DERIVED} "
        f"FROM (SELECT test_id, {LIST_METRICS} FROM runs WHERE {window}{extra_where} GROUP BY test_id) AS a "
        f"JOIN tests AS t ON t.id = a.test_id {page_after} {LIST_ORDER}"
    )


# --------------------------------------------------------------------------- measuring


@dataclass
class Measurement:
    elapsed: float  # seconds, as the server counts them
    read_rows: Optional[int]
    read_bytes: Optional[int]
    peak_memory: Optional[int]


class Probe(Http):
    """migrate.py's connection, plus a measured run that reads the summary header."""

    def measure(self, sql: str) -> Measurement:
        url = self.url + "&" + urllib.parse.urlencode({"wait_end_of_query": 1})
        request = urllib.request.Request(url, data=sql.encode(), method="POST")
        request.add_header("X-ClickHouse-User", self.user)
        if self.password:
            request.add_header("X-ClickHouse-Key", self.password)
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                response.read()
                summary = json.loads(response.headers.get("X-ClickHouse-Summary", "{}"))
        except urllib.error.HTTPError as error:
            raise Failed(
                f"HTTP {error.code}: {error.read().decode(errors='replace').strip()}"
            ) from None
        except OSError as error:
            raise Failed(f"cannot reach {self.url.split('?')[0]}: {error}") from None
        wall = time.perf_counter() - started
        elapsed = int(summary.get("elapsed_ns", 0)) / 1e9 or wall

        def number(key: str) -> Optional[int]:
            return int(summary[key]) if key in summary else None

        return Measurement(
            elapsed,
            number("read_rows"),
            number("read_bytes"),
            number("peak_memory_usage"),
        )


# --------------------------------------------------------------------------- parameters


@dataclass
class Params:
    anchor: str  # the newest started_at, as a SQL literal
    anchor_text: str  # the same, readable
    span_days: int  # days of data before the anchor
    test_id: str
    test: Dict[str, str]  # repo, file, suite, case_name, declared_case_name, language
    env_id: str
    env: Dict[str, str]  # the 11 environment identity columns
    flags_id: str
    flags_text: str  # KEY=value, ... or 'none'
    cursor_sql: str  # WHERE ...: the list page's rows after its first page over the prototype's window
    cursor_text: str  # the test that first page ends on, readable
    trunk_jobs: str  # SELECT ...: the job ids that stand for trunk jobs
    trunk_text: str  # how they were chosen, readable
    job_id: str
    file: str
    owner: str
    search: str


TSV_ESCAPES = {
    "\\t": "\t",
    "\\n": "\n",
    "\\r": "\r",
    "\\'": "'",
    "\\\\": "\\",
    "\\0": "\0",
    "\\b": "\b",
    "\\f": "\f",
}


def tsv_fields(line: str) -> List[str]:
    """Split one TabSeparated line and undo its escapes."""
    fields = []
    for field in line.split("\t"):
        out, i = [], 0
        while i < len(field):
            pair = field[i : i + 2]
            if pair in TSV_ESCAPES:
                out.append(TSV_ESCAPES[pair])
                i += 2
            else:
                out.append(field[i])
                i += 1
        fields.append("".join(out))
    return fields


def rows(probe: Probe, sql: str) -> List[List[str]]:
    text = probe.run(sql).rstrip("\n")
    if not text:
        raise Failed(f"no rows for: {sql.strip().splitlines()[0]}")
    return [tsv_fields(line) for line in text.split("\n")]


def first_row(probe: Probe, sql: str) -> List[str]:
    return rows(probe, sql)[0]


def discover(probe: Probe, search: str) -> Params:
    """Pick the query parameters from the data: a test that is actually run,
    its busiest environment and flag set, where the first list page ends, a
    busy job, the largest file, and an owner label, all relative to the newest
    row."""
    anchor_text, span = first_row(
        probe,
        "SELECT toString(max(started_at)), dateDiff('day', min(started_at), max(started_at)) FROM runs",
    )
    anchor = f"toDateTime64({sql_str(anchor_text)}, 3, 'UTC')"

    preferred = (
        "WHERE file = 'test/test_ops.py' AND suite = 'TestCommonCUDA' "
        "AND case_name = 'test_out_add_cuda_float32'"
    )
    found = probe.run(
        f"SELECT toString(id), {TEST_COLUMNS} FROM tests {preferred} LIMIT 1"
    ).rstrip("\n")
    if not found:
        found = probe.run(
            f"SELECT toString(id), {TEST_COLUMNS} FROM tests ORDER BY file, suite, case_name LIMIT 1"
        ).rstrip("\n")
    fields = tsv_fields(found)
    test_id, test = fields[0], dict(zip(TEST_COLUMNS.split(", "), fields[1:]))

    env_id, flags_id = first_row(
        probe,
        f"SELECT toString(env_id), toString(flags_id) FROM runs WHERE test_id = {test_id} "
        "GROUP BY env_id, flags_id ORDER BY count() DESC, env_id, flags_id LIMIT 1",
    )
    env_values = first_row(
        probe, f"SELECT {ENV_COLUMNS} FROM environments WHERE id = {env_id}"
    )
    env = dict(zip(ENV_COLUMNS.split(", "), env_values))
    keys, values = first_row(
        probe,
        "SELECT arrayStringConcat(mapKeys(flags), '\\x1f'), arrayStringConcat(mapValues(flags), '\\x1f') "
        f"FROM flags WHERE id = {flags_id}",
    )
    flags_text = (
        ", ".join(f"{k}={v}" for k, v in zip(keys.split("\x1f"), values.split("\x1f")))
        if keys
        else "none"
    )

    # The keyset cursor the prototype pages with: the last row of the first
    # list page (or of the only page, when there are fewer tests), as the
    # prototype's window sees it. The next page is everything sorting after it.
    page = rows(probe, list_page(window_sql(anchor, PROTOTYPE_WINDOW)))
    last = dict(zip(LIST_COLUMNS, page[min(len(page), PAGE - 1) - 1]))
    cursor_sql = (
        f"WHERE avg_ms < {last['avg_ms']} OR (avg_ms = {last['avg_ms']} AND (file, suite, case_name) > "
        f"({sql_str(last['file'])}, {sql_str(last['suite'])}, {sql_str(last['case_name'])}))"
    )
    cursor_text = f"{last['file']}  {last['suite']}  {last['case_name']}  ({float(last['avg_ms']):.1f} ms)"

    # The hub tells trunk jobs from pull request jobs through default.workflow_job,
    # so a trunk-only page filters on a set of job ids. The trial data has no
    # such table; one id in three over the week's range, picked by hash, stands
    # in for that set, and what is timed is the filter on the fact table.
    low, high = first_row(
        probe,
        "SELECT toString(min(github_workflow_job_id)), toString(max(github_workflow_job_id)) "
        f"FROM runs WHERE {window_sql(anchor, PROTOTYPE_WINDOW)}",
    )
    trunk_jobs = (
        f"SELECT toInt64(number) FROM numbers({low}, {int(high) - int(low) + 1}) "
        "WHERE cityHash64(number) % 3 = 0"
    )
    trunk_text = f"one job id in three from {low} to {high}, by hash"

    job_id = first_row(
        probe,
        f"SELECT toString(github_workflow_job_id) FROM runs WHERE {window_sql(anchor, 1)} "
        "GROUP BY github_workflow_job_id ORDER BY count() DESC, github_workflow_job_id LIMIT 1",
    )[0]
    big_file = first_row(
        probe,
        "SELECT file FROM tests GROUP BY file ORDER BY count() DESC, file LIMIT 1",
    )[0]
    owner = first_row(
        probe,
        f"SELECT owner FROM ({NEWEST_OWNERS}) ARRAY JOIN owners AS owner "
        "GROUP BY owner ORDER BY owner = 'module: inductor' DESC, count() DESC, owner LIMIT 1",
    )[0]
    return Params(
        anchor,
        anchor_text,
        int(span),
        test_id,
        test,
        env_id,
        env,
        flags_id,
        flags_text,
        cursor_sql,
        cursor_text,
        trunk_jobs,
        trunk_text,
        job_id,
        big_file,
        owner,
        search,
    )


# --------------------------------------------------------------------------- the queries


@dataclass
class Query:
    short: str  # the name used in the summary table
    description: str  # one line, printed with the detail block
    sql: str
    window: Optional[str]  # None: follows --window-days; otherwise a fixed label


# Summary names and the window each query covers: None follows --window-days,
# a number of days is fixed, and a label says what else bounds the query.
NAMES: Tuple[Tuple[str, Union[None, int, str]], ...] = (
    ("List page", None),
    ("List page + search", None),
    ("List page, next page", PROTOTYPE_WINDOW),
    ("List page, one platform", PROTOTYPE_WINDOW),
    ("List page, trunk only", PROTOTYPE_WINDOW),
    ("Flaky tests", PROTOTYPE_WINDOW),
    ("Slower tests", PROTOTYPE_WINDOW),
    ("New and gone tests", TTL_DAYS),
    ("Test detail metrics", None),
    ("Test detail runs", None),
    ("Where does it run", "all"),
    ("Config timeline", "all"),
    ("File page", None),
    ("Failure messages", PROTOTYPE_WINDOW),
    ("File durations", 1),
    ("Owner page", None),
    ("Job page", "1 job"),
    ("Environment health", 1),
)


def queries(p: Params, days: int) -> List[Query]:
    """The queries for a window of `days` before the anchor."""
    window = window_sql(p.anchor, days)
    day = window_sql(p.anchor, 1)
    week = window_sql(p.anchor, PROTOTYPE_WINDOW)
    fortnight = window_sql(p.anchor, TTL_DAYS)
    s = sql_str(p.search)
    accelerator = sql_str(p.env["accelerator"])
    repo, file = sql_str(p.test["repo"]), sql_str(p.file)
    env_cols = ", ".join("e." + c for c in ENV_COLUMNS.split(", "))
    search_tests = (
        f"positionCaseInsensitiveUTF8(file, {s}) > 0 OR positionCaseInsensitiveUTF8(suite, {s}) > 0 "
        f"OR positionCaseInsensitiveUTF8(case_name, {s}) > 0"
    )
    # flaky: a pass at rerun_number > 0 followed failed attempts in the same
    # process, except under the flag whose repeats are not reruns
    flaky_metrics = (
        "countIf(outcome = 'passed' AND rerun_number > 0) AS recovered, "
        f"countIf({BAD}) AS failed, count() AS runs"
    )
    flaky_order = f"ORDER BY recovered DESC, file, suite, case_name LIMIT {PAGE}"
    # slower: the passed durations of the newest day against the days before it
    last_day = f"outcome = 'passed' AND started_at > {p.anchor} - INTERVAL 1 DAY"
    before = f"outcome = 'passed' AND started_at <= {p.anchor} - INTERVAL 1 DAY"
    slower_metrics = (
        f"intDivOrZero(sumIf({MS}, {before}), countIf({before})) AS before_ms, "
        f"intDivOrZero(sumIf({MS}, {last_day}), countIf({last_day})) AS last_ms, "
        "intDivOrZero(last_ms * 100, before_ms) AS ratio_pct"
    )
    slower_having = f"HAVING countIf({before}) >= 3 AND countIf({last_day}) >= 3"
    slower_order = f"ORDER BY ratio_pct DESC, file, suite, case_name LIMIT {PAGE}"
    # new and gone: first seen inside the prototype's window, or not seen since it began
    week_ago = f"{p.anchor} - INTERVAL {PROTOTYPE_WINDOW} DAY"
    churn_metrics = "min(started_at) AS first_run, max(started_at) AS last_run"
    churn_having = f"HAVING first_run > {week_ago} OR last_run <= {week_ago}"
    churn_status = f"if(first_run > {week_ago}, 'new', 'gone') AS status"
    churn_order = f"ORDER BY status, last_run DESC, file, suite, case_name LIMIT {PAGE}"
    messages = "SELECT outcome, outcome_summary, count() AS n, max(started_at) AS last_seen FROM"
    messages_tail = "GROUP BY outcome, outcome_summary ORDER BY n DESC, outcome, outcome_summary LIMIT 20"
    attempt_columns = f"started_at, github_workflow_job_id, rerun_number, outcome, outcome_summary, {MS} AS ms"
    newest_first = "ORDER BY started_at DESC, github_workflow_job_id DESC, rerun_number"

    items = [
        (
            f"metrics of every test in the window, sorted by average duration, first {PAGE}",
            list_page(window),
        ),
        (
            f"the same metrics for the tests whose file, suite or name contains {p.search!r}",
            list_page(
                window, f" AND test_id IN (SELECT id FROM tests WHERE {search_tests})"
            ),
        ),
        (
            f"the {PAGE} tests after the first page, through the keyset cursor the prototype pages with",
            list_page(week, page_after=p.cursor_sql),
        ),
        (
            f"the list page restricted to the {p.env['accelerator']} environments",
            list_page(
                week,
                f" AND env_id IN (SELECT id FROM environments WHERE accelerator = {accelerator})",
            ),
        ),
        (
            "the list page over trunk jobs only: a third of the week's job ids, standing in for the set "
            "a join to default.workflow_job would give",
            list_page(week, f" AND github_workflow_job_id IN ({p.trunk_jobs})"),
        ),
        (
            f"tests that passed only after a failed attempt, outside {RERUN_DISABLED} jobs, first {PAGE}",
            "SELECT t.file AS file, t.suite AS suite, t.case_name AS case_name, recovered, failed, runs "
            f"FROM (SELECT test_id, {flaky_metrics} FROM runs WHERE {week} "
            f"AND flags_id NOT IN (SELECT id FROM flags WHERE mapContains(flags, '{RERUN_DISABLED}')) "
            f"GROUP BY test_id HAVING recovered > 0) AS a JOIN tests AS t ON t.id = a.test_id {flaky_order}",
        ),
        (
            "tests whose passed attempts took longest in the newest day relative to the six days before, "
            f"with at least three passes in each, first {PAGE}",
            "SELECT t.file AS file, t.suite AS suite, t.case_name AS case_name, before_ms, last_ms, ratio_pct "
            f"FROM (SELECT test_id, {slower_metrics} FROM runs WHERE {week} GROUP BY test_id {slower_having}) AS a "
            f"JOIN tests AS t ON t.id = a.test_id {slower_order}",
        ),
        (
            f"tests first seen in the last {PROTOTYPE_WINDOW} days or not seen since, over the {TTL_DAYS} days "
            f"the tables keep, first {PAGE}",
            f"SELECT t.file AS file, t.suite AS suite, t.case_name AS case_name, {churn_status}, first_run, last_run "
            f"FROM (SELECT test_id, {churn_metrics} FROM runs WHERE {fortnight} GROUP BY test_id {churn_having}) AS a "
            f"JOIN tests AS t ON t.id = a.test_id {churn_order}",
        ),
        (
            "one test over the window: runs, passed, failed, skipped, average duration",
            f"SELECT {LIST_DERIVED} FROM (SELECT {LIST_METRICS} FROM runs WHERE test_id = {p.test_id} AND {window})",
        ),
        (
            f"the first page of one test's attempts in the window, newest first, {RUNS_PAGE} rows",
            f"SELECT {attempt_columns} FROM runs WHERE test_id = {p.test_id} "
            f"AND {window} {newest_first} LIMIT {RUNS_PAGE}",
        ),
        (
            "every environment and flag set one test ran in, with counts and last run",
            f"SELECT {env_cols}, toString(f.flags) AS flags, a.c AS runs, a.s AS skipped, a.last AS last_run "
            "FROM (SELECT env_id, flags_id, count() AS c, countIf(outcome = 'skipped') AS s, max(started_at) AS last "
            f"FROM runs WHERE test_id = {p.test_id} GROUP BY env_id, flags_id) AS a "
            "JOIN environments AS e ON e.id = a.env_id JOIN flags AS f ON f.id = a.flags_id "
            "ORDER BY runs DESC, flags, device_name",
        ),
        (
            "the newest 50 attempts of one test in one environment and flag set",
            "SELECT started_at, github_workflow_job_id, rerun_number, outcome, outcome_summary "
            f"FROM runs WHERE test_id = {p.test_id} AND env_id = {p.env_id} AND flags_id = {p.flags_id} "
            f"{newest_first} LIMIT 50",
        ),
        (
            f"health of every test in {p.file} over the window, top 20 by failures",
            "SELECT t.suite AS suite, t.case_name AS case_name, a.c AS runs, a.f AS failed, a.s AS skipped "
            f"FROM (SELECT test_id, count() AS c, countIf({BAD}) AS f, countIf(outcome = 'skipped') AS s "
            f"FROM runs WHERE test_id IN (SELECT id FROM tests WHERE repo = {repo} AND file = {file}) "
            f"AND {window} GROUP BY test_id) AS a "
            "JOIN tests AS t ON t.id = a.test_id ORDER BY failed DESC, suite, case_name LIMIT 20",
        ),
        (
            f"the 20 most frequent failure messages in {p.file}, with their outcome and last sighting",
            f"{messages} runs WHERE test_id IN (SELECT id FROM tests WHERE repo = {repo} AND file = {file}) "
            f"AND {week} AND {BAD} {messages_tail}",
        ),
        (
            "time spent and attempts per file over the newest day, most expensive first",
            "SELECT t.file AS file, sum(a.ms) AS total_ms, sum(a.c) AS runs "
            f"FROM (SELECT test_id, sum({MS}) AS ms, count() AS c FROM runs WHERE {day} GROUP BY test_id) AS a "
            "JOIN tests AS t ON t.id = a.test_id GROUP BY file ORDER BY total_ms DESC, file",
        ),
        (
            f"runs and failures over the window per file owned by {p.owner!r}",
            "SELECT t.file AS file, sum(a.c) AS runs, sum(a.f) AS failed, count() AS tests "
            f"FROM (SELECT test_id, count() AS c, countIf({BAD}) AS f FROM runs "
            f"WHERE test_id IN (SELECT id FROM tests WHERE (repo, file) IN "
            f"(SELECT repo, file FROM ({NEWEST_OWNERS}) WHERE has(owners, {sql_str(p.owner)}))) "
            f"AND {window} GROUP BY test_id) AS a JOIN tests AS t ON t.id = a.test_id GROUP BY file ORDER BY file",
        ),
        (
            "the non-passing attempts of one job, with test names",
            "SELECT t.file, t.suite, t.case_name, r.rerun_number, r.outcome, r.outcome_summary "
            f"FROM runs AS r JOIN tests AS t ON t.id = r.test_id WHERE r.github_workflow_job_id = {p.job_id} "
            "AND r.outcome != 'passed' ORDER BY t.file, t.suite, t.case_name, r.rerun_number LIMIT 100",
        ),
        (
            "pass and failure counts per environment over the newest day",
            f"SELECT {env_cols}, a.c AS runs, a.p AS passed, a.f AS failed "
            f"FROM (SELECT env_id, count() AS c, countIf(outcome = 'passed') AS p, countIf({BAD}) AS f "
            f"FROM runs WHERE {day} GROUP BY env_id) AS a JOIN environments AS e ON e.id = a.env_id "
            "ORDER BY runs DESC, device_name, python_version",
        ),
    ]
    assert len(items) == len(NAMES), "every query needs a name in NAMES"

    def label(spec: Union[None, int, str]) -> Optional[str]:
        if isinstance(spec, int):
            return f"{spec}d{'*' if spec > p.span_days else ''}"
        return spec

    return [
        Query(short, description, sql, label(spec))
        for (short, spec), (description, sql) in zip(NAMES, items)
    ]


# --------------------------------------------------------------------------- running


def estimate(probe: Probe, sql: str, table: str) -> Tuple[int, int]:
    """(rows, marks) EXPLAIN ESTIMATE says the fact table will read."""
    total_rows = total_marks = 0
    for line in probe.run(f"EXPLAIN ESTIMATE {sql}").splitlines():
        fields = line.split("\t")  # database, table, parts, rows, marks
        if len(fields) == 5 and fields[1] == table:
            total_rows += int(fields[3])
            total_marks += int(fields[4])
    return total_rows, total_marks


def human(value: Optional[int], unit: str = "") -> str:
    if value is None:
        return "?"
    for scale, suffix in ((1e9, "G"), (1e6, "M"), (1e3, "k")):
        if value >= scale:
            return f"{value / scale:.1f}{suffix}{unit}"
    return f"{value}{unit}"


def human_bytes(value: Optional[int]) -> str:
    if value is None:
        return "?"
    for scale, suffix in ((1e9, "GB"), (1e6, "MB"), (1e3, "kB")):
        if value >= scale:
            return f"{value / scale:.1f} {suffix}"
    return f"{value} B"


def what_was_read(runs: List[Measurement], estimated_rows: int) -> str:
    """Rows and bytes the server reported, or the estimate when it reported none."""
    if runs[0].read_rows is None:
        return f"~{human(estimated_rows)} rows (estimate)"
    return f"{human(runs[0].read_rows)} rows, {human_bytes(runs[0].read_bytes)}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    parser.add_argument(
        "--rounds", type=int, default=3, help="timed runs per query (default 3)"
    )
    parser.add_argument(
        "--search",
        default="softmax",
        help="search term for the list page (default softmax)",
    )
    parser.add_argument(
        "--window-days",
        type=int,
        nargs="+",
        default=list(DEFAULT_WINDOWS),
        metavar="DAYS",
        help="windows to time the window-dependent queries over (default 1 7 14 30)",
    )
    args = parser.parse_args(argv)
    try:
        return report(Probe(SANDBOX), args.rounds, args.search, args.window_days)
    except Failed as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def report(probe: Probe, rounds: int, search: str, windows: List[int]) -> int:
    p = discover(probe, search)
    total = int(first_row(probe, "SELECT count() FROM runs")[0])
    too_long = {d for d in windows if d > p.span_days}
    env = p.env
    print("Setup")
    print(
        f"  data     {total:,} attempts over {p.span_days} days, newest {p.anchor_text[:16]} UTC"
    )
    print(f"  test     {p.test['file']}  {p.test['suite']}  {p.test['case_name']}")
    device = (
        f"{env['device_name']} x{env['device_count']}"
        if env["device_name"]
        else "no device"
    )
    print(
        f"  config   {env['os']} {env['accelerator']} {env['accelerator_version']}, {device}, "
        f"python {env['python_version']}, flags {p.flags_text}"
    )
    print(
        f"  platform {env['accelerator']}, for the list page restricted to one platform"
    )
    print(
        f"  cursor   {p.cursor_text}, where the {PROTOTYPE_WINDOW}-day list page ends and its next page starts"
    )
    print(f"  trunk    {p.trunk_text}, standing in for the trunk jobs")
    print(f"  job      {p.job_id}    file {p.file}    owner {p.owner}")
    marked = ", ".join(f"{d}d{'*' if d in too_long else ''}" for d in windows)
    note = "   * longer than the data, so it reads all of it" if too_long else ""
    print(f"  windows  {marked}{note}")
    print(
        f"  rounds   {rounds} timed run{'s' if rounds != 1 else ''} per query; the median counts"
    )

    # (query index, window index, label, query, timed runs, estimated rows)
    results = []
    for w, days in enumerate(windows):
        for i, query in enumerate(queries(p, days)):
            if query.window is not None and w > 0:
                continue
            label = query.window or f"{days}d{'*' if days in too_long else ''}"
            print(f"\n== {query.short} [{label}]: {query.description}", flush=True)
            estimated = estimate(probe, query.sql, "runs")[0]
            runs = [probe.measure(query.sql) for _ in range(rounds)]
            median = statistics.median(m.elapsed for m in runs)
            times = " ".join(f"{m.elapsed:.2f}" for m in runs)
            print(
                f"   median {median:6.2f} s   times {times:<{7 * rounds}}  read {what_was_read(runs, estimated)}",
                flush=True,
            )
            results.append((i, w, label, query, runs, estimated))
    results.sort(key=lambda r: (r[0], r[1]))

    print("\nSummary  (median seconds)\n")
    widths = (24, 6, 9, 26)
    header = ("Query", "Window", "Median", "Read")

    def row(cells, aligns="<<><"):
        return (
            "| "
            + " | ".join(f"{c:{a}{w}}" for c, a, w in zip(cells, aligns, widths))
            + " |"
        )

    print(row(header))
    print("| " + " | ".join("-" * w for w in widths) + " |")
    slow = []
    last_query = None
    for _i, _w, label, query, runs, estimated in results:
        median = statistics.median(m.elapsed for m in runs)
        if median >= 1.0:
            slow.append((median, f"{query.short} [{label}] {median:.2f} s"))
        name = query.short if query.short != last_query else ""
        last_query = query.short
        print(row((name, label, f"{median:.2f} s", what_was_read(runs, estimated))))

    if slow:
        slow.sort(reverse=True)
        print(
            "\nSlowest, at a second or more: "
            + "; ".join(text for _, text in slow[:3])
            + "."
        )
    else:
        print("\nEvery query ran in under a second.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
