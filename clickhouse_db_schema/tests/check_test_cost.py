#!/usr/bin/env python3
"""Sanity checks for fortesting.test_cost after a refresh or a backfill.

    python3 check_test_cost.py --days 2026-11-01:2026-11-03 [--repo pytorch/pytorch]
                               [--table fortesting.test_cost] [--sample 20]

Each check prints PASS, FAIL, WARN or INFO with the numbers it compared; the
script exits 1 if any check fails or errors. Only the latest computed_at of
each (repo, day) is read, as the page reads it. Every query is a bounded,
read-only SELECT on the service migrate.py uses (CLICKHOUSE_ENDPOINT,
CLICKHOUSE_USERNAME, CLICKHOUSE_PASSWORD); ci.runs is read without FINAL,
through its by_job projection.

--table also takes "@file.sql": a SELECT used in place of the table, e.g. the
view's query for one day, to try the checks before the table exists. --sample N
keeps the jobs with cityHash64(id) % N = 0 in the independent workflow_job and
ci.runs queries; give the stand-in the same sample.
"""

import argparse
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import migrate  # noqa: E402


BOUNDS = "max_threads = 8, max_memory_usage = 8000000000, max_execution_time = 120"
REL = 1e-9  # relative tolerance for float sums of the same seconds
ROUNDING = 0.0005  # seconds: each stored row rounds to the millisecond
TEST_JOB = r"'(?:^|/ )test \\('"  # cost API's test job pattern, as the view uses it


class Checker:
    def __init__(self, args: argparse.Namespace) -> None:
        self.repo = args.repo
        start, _, end = args.days.partition(":")
        self.d0 = date.fromisoformat(start)
        self.d1 = date.fromisoformat(end or start)
        # A stand-in SELECT is one computation, but each reference to it runs
        # again with its own now64(), so its versions are not compared.
        self.standin = args.table.startswith("@")
        if self.standin:
            self.table = (
                "(\n" + Path(args.table[1:]).read_text().strip().rstrip(";") + "\n)"
            )
        else:
            self.table = args.table
        self.sample = f" AND cityHash64(id) % {args.sample} = 0" if args.sample else ""
        self.http = migrate.Http("default")
        self.failed = 0

    # ------------------------------------------------------------------ helpers

    def rows(self, sql: str) -> List[dict]:
        return migrate.rows_of(
            self.http,
            sql + f"\nSETTINGS join_use_nulls = 0, {BOUNDS}\nFORMAT JSONEachRow",
        )

    def report(self, status: str, name: str, text: str) -> None:
        if status in ("FAIL", "ERROR"):
            self.failed += 1
        print(f"{status:5} {name}: {text}")

    def days(self) -> List[date]:
        return [
            self.d0 + timedelta(days=i) for i in range((self.d1 - self.d0).days + 1)
        ]

    def latest(self) -> str:
        """test_cost rows of each (repo, day)'s latest computation."""
        where = f"repo = '{self.repo}' AND day >= toDate('{self.d0}') AND day <= toDate('{self.d1}')"
        if self.standin:
            return f"latest AS (SELECT * FROM {self.table} WHERE {where})"
        return f"""latest AS (
        SELECT x.*
        FROM {self.table} AS x
        INNER JOIN (
            SELECT repo, day, max(computed_at) AS c FROM {self.table} WHERE {where} GROUP BY repo, day
        ) AS l ON l.repo = x.repo AND l.day = x.day AND l.c = x.computed_at
        WHERE x.{where.replace(" AND day", " AND x.day")}
    )"""

    def jobs_cte(self) -> str:
        """Completed jobs of the days, latest version per id, by the cost API's
        rules (the view's), with whether each is a test job."""
        return f"""jobs AS (
        SELECT
            j.id AS id,
            toDate(j.started_at) AS day,
            w.path AS workflow_path,
            match(j.name, {TEST_JOB}) AS is_test_job,
            dateDiff('millisecond', j.started_at, j.completed_at) / 1000 AS wall,
            toUnixTimestamp64Milli(toDateTime64(j.started_at, 3)) AS job_start,
            toUnixTimestamp64Milli(toDateTime64(j.completed_at, 3)) AS job_end
        FROM (
            SELECT id, run_id, name, status, conclusion, runner_name, created_at, started_at, completed_at
            FROM default.workflow_job
            WHERE repository_full_name = '{self.repo}'
                AND started_at >= toDate('{self.d0}') AND started_at < toDate('{self.d1}') + 1{self.sample}
            ORDER BY _inserted_at DESC
            LIMIT 1 BY id
        ) AS j
        LEFT JOIN (
            SELECT id, any(path) AS path
            FROM default.workflow_run
            WHERE id IN (
                SELECT run_id FROM default.workflow_job
                WHERE repository_full_name = '{self.repo}'
                    AND started_at >= toDate('{self.d0}') AND started_at < toDate('{self.d1}') + 1
            )
            GROUP BY id
        ) AS w ON w.id = j.run_id
        WHERE j.status = 'completed'
            AND j.conclusion NOT IN ('skipped', '')
            AND j.runner_name != ''
            AND j.started_at >= j.created_at
            AND dateDiff('second', j.started_at, j.completed_at) BETWEEN 0 AND 86400
    )"""

    @staticmethod
    def close(a: float, b: float, rows: int = 0) -> bool:
        """Equal but for float error and the rounding of rows rows."""
        return abs(a - b) <= REL * max(abs(a), abs(b), 1.0) + ROUNDING * rows

    # ------------------------------------------------------------------ checks

    def check_freshness(self) -> None:
        """1. Every day has rows; the view's window (today - 3 .. today) was
        refreshed within 3.5 hours."""
        rows = self.rows(f"""
SELECT
    toString(day) AS d,
    count() AS rows,
    uniqExact(computed_at) AS versions,
    toString(max(computed_at)) AS latest,
    dateDiff('minute', max(computed_at), now64(3, 'UTC')) AS minutes_old,
    day >= today() - 3 AS in_view_window
FROM {self.table}
WHERE repo = '{self.repo}' AND day >= toDate('{self.d0}') AND day <= toDate('{self.d1}')
GROUP BY day
ORDER BY day""")
        seen = {r["d"]: r for r in rows}
        missing = [str(d) for d in self.days() if str(d) not in seen]
        stale = [
            r["d"] for r in rows if r["in_view_window"] and int(r["minutes_old"]) > 210
        ]
        detail = ", ".join(
            f"{r['d']}: {r['rows']} rows, {r['versions']} versions, latest {r['latest']} ({r['minutes_old']} min ago)"
            for r in rows
        )
        if missing or stale:
            self.report(
                "FAIL",
                "1 freshness",
                f"days without rows {missing or 'none'}, days in the view's window older than 3.5 h "
                f"{stale or 'none'} | {detail}",
            )
        else:
            self.report(
                "PASS",
                "1 freshness",
                f"every day has rows; recent days are fresh | {detail}",
            )

    def table_sums(self) -> List[dict]:
        """Per (day, workflow) sums and rule violations of the latest rows."""
        return self.rows(f"""
WITH {self.latest()}
SELECT
    toString(day) AS d,
    workflow_path,
    count() AS rows,
    sum(occupancy_runner_milliseconds) / 1000 AS occupancy,
    sum(test_ratio_runner_milliseconds) / 1000 AS test_ratio,
    sum(held_milliseconds) / 1000 AS held,
    sum(executed_test_milliseconds) / 1000 AS executed,
    sum(skipped_test_milliseconds) / 1000 AS skipped,
    sumIf(occupancy_runner_milliseconds, test_file = '') / 1000 AS no_report,
    countIf(held_milliseconds > occupancy_runner_milliseconds) AS held_over_occupancy_rows,
    countIf(test_file = '' AND (held_milliseconds != 0 OR executed_test_milliseconds != 0
        OR skipped_test_milliseconds != 0 OR environments_id != 0)) AS bad_no_report_rows,
    countIf(test_file != '' AND held_milliseconds = 0 AND executed_test_milliseconds = 0
        AND skipped_test_milliseconds = 0)
        AS empty_file_rows,
    countIf(empty(runner_labels)) AS unlabeled_rows
FROM latest
GROUP BY day, workflow_path
ORDER BY day, workflow_path""")

    def source_sums(self) -> List[dict]:
        """Per (day, workflow), independently of the view: wall time of test
        jobs, of other jobs with a report span, and of test jobs without one.
        A report's span is its runs' first start to last end, clipped to the
        job; every report has one test file, so this is the view's span."""
        return self.rows(f"""
WITH
    {self.jobs_cte()},
    spanned AS (
        SELECT DISTINCT r.job_id AS id
        FROM (
            SELECT github_workflow_job_id AS job_id, report_uuid,
                min(toUnixTimestamp64Milli(started_at)) AS first_start,
                max(toUnixTimestamp64Milli(ended_at)) AS last_end
            FROM ci.runs
            WHERE github_workflow_job_id IN (SELECT id FROM jobs)
                AND toDate(started_at) >= toDate('{self.d0}') AND toDate(started_at) <= toDate('{self.d1}') + 1
            GROUP BY job_id, report_uuid
        ) AS r
        INNER JOIN jobs AS j ON j.id = r.job_id
        WHERE least(r.last_end, j.job_end) > greatest(r.first_start, j.job_start)
    )
SELECT
    toString(day) AS d,
    workflow_path,
    sumIf(wall, is_test_job) AS test_job_wall,
    sumIf(wall, NOT is_test_job AND id IN (SELECT id FROM spanned)) AS other_reporting_wall,
    sumIf(wall, is_test_job AND id NOT IN (SELECT id FROM spanned)) AS no_report_wall,
    countIf(is_test_job) AS test_jobs,
    countIf(NOT is_test_job AND id IN (SELECT id FROM spanned)) AS other_reporting_jobs,
    countIf(is_test_job AND id NOT IN (SELECT id FROM spanned)) AS no_report_jobs
FROM jobs
GROUP BY day, workflow_path
HAVING test_jobs > 0 OR other_reporting_jobs > 0
ORDER BY day, workflow_path""")

    def check_methods_agree(self, sums: List[dict]) -> None:
        """2. Occupancy and test-time ratio split the same wall time."""
        worst = max(
            sums,
            key=lambda r: abs(float(r["occupancy"]) - float(r["test_ratio"])),
            default=None,
        )
        bad = [
            r
            for r in sums
            if not self.close(
                float(r["occupancy"]), float(r["test_ratio"]), int(r["rows"])
            )
        ]
        occupancy = sum(float(r["occupancy"]) for r in sums)
        ratio = sum(float(r["test_ratio"]) for r in sums)
        text = (
            f"occupancy {occupancy:.3f} s vs test ratio {ratio:.3f} s over {len(sums)} (day, workflow) groups; "
            f"largest gap {abs(float(worst['occupancy']) - float(worst['test_ratio'])) if worst else 0:.2e} s"
        )
        if bad:
            self.report(
                "FAIL",
                "2 methods agree",
                text
                + " | off: "
                + ", ".join(f"{r['d']} {r['workflow_path']}" for r in bad[:5]),
            )
        else:
            self.report(
                "PASS",
                "2 methods agree",
                text + "; both split each job's whole wall time",
            )

    def check_totals(self, sums: List[dict], source: List[dict]) -> None:
        """3. Each day's total is the wall time of the jobs the view includes."""
        by_day: Dict[str, List[float]] = {}
        rows_by_day: Dict[str, int] = {}
        for r in sums:
            by_day.setdefault(r["d"], [0.0, 0.0])[0] += float(r["occupancy"])
            rows_by_day[r["d"]] = rows_by_day.get(r["d"], 0) + int(r["rows"])
        for r in source:
            by_day.setdefault(r["d"], [0.0, 0.0])[1] += float(
                r["test_job_wall"]
            ) + float(r["other_reporting_wall"])
        others = sum(float(r["other_reporting_wall"]) for r in source)
        other_jobs = sum(int(r["other_reporting_jobs"]) for r in source)
        parts = [
            f"{d}: table {t:.3f} s vs jobs {s:.3f} s"
            for d, (t, s) in sorted(by_day.items())
        ]
        bad = [
            d
            for d, (t, s) in by_day.items()
            if not self.close(t, s, rows_by_day.get(d, 0))
        ]
        text = " | ".join(parts) + (
            f" (jobs = test jobs + {other_jobs} other jobs with test reports, {others:.0f} s)"
        )
        if bad:
            gaps = {}
            table_w = {
                (r["d"], r["workflow_path"]): float(r["occupancy"]) for r in sums
            }
            for r in source:
                key = (r["d"], r["workflow_path"])
                gaps[key] = (
                    table_w.pop(key, 0.0)
                    - float(r["test_job_wall"])
                    - float(r["other_reporting_wall"])
                )
            gaps.update(table_w)
            top = sorted(gaps.items(), key=lambda kv: -abs(kv[1]))[:5]
            self.report(
                "FAIL",
                "3 totals match workflow_job",
                text
                + " | largest (day, workflow) gaps: "
                + ", ".join(f"{d} {w} {g:+.1f} s" for (d, w), g in top),
            )
        else:
            self.report("PASS", "3 totals match workflow_job", text)

    def check_rows(self, sums: List[dict]) -> None:
        """4. Every row is internally consistent."""
        counts = {
            k: sum(int(r[k]) for r in sums)
            for k in (
                "held_over_occupancy_rows",
                "bad_no_report_rows",
                "empty_file_rows",
                "unlabeled_rows",
            )
        }
        day_held: Dict[str, List[float]] = {}
        for r in sums:
            d = day_held.setdefault(r["d"], [0.0, 0.0])
            d[0] += float(r["held"])
            d[1] += float(r["occupancy"])
        over_days = [d for d, (h, o) in day_held.items() if h > o * (1 + REL) + 1e-6]
        rows = sum(int(r["rows"]) for r in sums)
        text = (
            f"{rows} rows: {counts['held_over_occupancy_rows']} with held > "
            f"occupancy, {counts['bad_no_report_rows']} no-report rows with test time or a machine, "
            f"{counts['empty_file_rows']} file rows with no time, {counts['unlabeled_rows']} rows without "
            f"runner labels; days with held > occupancy: {over_days or 'none'}"
        )
        if (
            any(
                counts[k]
                for k in (
                    "held_over_occupancy_rows",
                    "bad_no_report_rows",
                    "unlabeled_rows",
                )
            )
            or over_days
        ):
            self.report("FAIL", "4 row sanity", text)
        else:
            self.report("PASS", "4 row sanity", text)

    def check_no_report(self, sums: List[dict], source: List[dict]) -> None:
        """5. test_file '' rows are exactly the test jobs without test reports."""
        table_w = {
            (r["d"], r["workflow_path"]): float(r["no_report"])
            for r in sums
            if float(r["no_report"])
        }
        source_w = {
            (r["d"], r["workflow_path"]): float(r["no_report_wall"])
            for r in source
            if float(r["no_report_wall"])
        }
        keys = sorted(set(table_w) | set(source_w))
        bad = [
            k for k in keys if not self.close(table_w.get(k, 0.0), source_w.get(k, 0.0))
        ]
        jobs = sum(int(r["no_report_jobs"]) for r in source)
        text = (
            f"table {sum(table_w.values()):.3f} s vs {jobs} test jobs without a report span "
            f"{sum(source_w.values()):.3f} s over {len(keys)} (day, workflow) groups"
        )
        if bad:
            self.report(
                "FAIL",
                "5 no-report rows",
                text
                + " | off: "
                + ", ".join(
                    f"{d} {w} table {table_w.get((d, w), 0):.1f} vs jobs {source_w.get((d, w), 0):.1f}"
                    for d, w in bad[:5]
                ),
            )
        else:
            self.report("PASS", "5 no-report rows", text)

    def check_executed(self, sums: List[dict]) -> None:
        """6. One small workflow-day's executed test time matches ci.runs: the
        smallest with at least an hour of it, so the check reads few runs but
        still covers real reports."""
        candidates = [r for r in sums if float(r["executed"]) >= 3600] or [
            r for r in sums if float(r["executed"]) > 0
        ]
        if not candidates:
            self.report(
                "FAIL", "6 executed time", "no (day, workflow) with executed test time"
            )
            return
        pick = min(candidates, key=lambda r: float(r["executed"]))
        d, wf = pick["d"], pick["workflow_path"]
        jobs = self.jobs_cte().replace(f"toDate('{self.d0}')", f"toDate('{d}')")
        jobs = jobs.replace(f"toDate('{self.d1}') + 1", f"toDate('{d}') + 1")
        row = self.rows(f"""
WITH {jobs}
SELECT
    sumIf(greatest(0, dateDiff('millisecond', started_at, ended_at)), outcome != 'skipped') / 1000 AS executed,
    sumIf(greatest(0, dateDiff('millisecond', started_at, ended_at)), outcome = 'skipped') / 1000 AS skipped,
    uniqExact(github_workflow_job_id) AS jobs
FROM ci.runs
WHERE github_workflow_job_id IN (SELECT id FROM jobs WHERE workflow_path = '{wf}')
    AND toDate(started_at) >= toDate('{d}') AND toDate(started_at) <= toDate('{d}') + 1""")[
            0
        ]
        table_e, table_s = float(pick["executed"]), float(pick["skipped"])
        runs_e, runs_s = float(row["executed"]), float(row["skipped"])
        ok = abs(table_e - runs_e) <= 1e-6 * max(table_e, runs_e, 1.0) and abs(
            table_s - runs_s
        ) <= 1e-6 * max(table_s, runs_s, 1.0)
        text = (
            f"{d} {wf} ({row['jobs']} jobs): executed table {table_e:.3f} s vs ci.runs {runs_e:.3f} s, "
            f"skipped table {table_s:.3f} s vs ci.runs {runs_s:.3f} s"
        )
        self.report("PASS" if ok else "FAIL", "6 executed time", text)

    def check_owners(self) -> None:
        """7. Snapshots against today's ci.owners (informational: ownership changes)."""
        row = self.rows(f"""
WITH {self.latest()}
SELECT
    countIf(test_file != '') AS file_rows,
    countIf(differs) AS differ_rows,
    sumIf(occupancy_runner_milliseconds, differs) / 3.6e6 AS differ_hours,
    countIf(test_file != '' AND empty(owners)) AS unowned_rows,
    sumIf(occupancy_runner_milliseconds, test_file != '' AND empty(owners)) / 3.6e6 AS unowned_hours
FROM (
    SELECT
        t.test_file AS test_file,
        t.owners AS owners,
        t.occupancy_runner_milliseconds AS occupancy_runner_milliseconds,
        t.test_file != '' AND arraySort(arrayMap(x -> toString(x), t.owners)) != arraySort(o.owners) AS differs
    FROM latest AS t
    LEFT JOIN (SELECT repo, file, owners FROM ci.owners FINAL) AS o ON o.repo = t.repo AND o.file = t.test_file
)""")[0]
        self.report(
            "INFO",
            "7 owners",
            f"{row['differ_rows']} of {row['file_rows']} file rows ({float(row['differ_hours']):.1f} h) have "
            f"snapshot owners that differ from today's ci.owners; {row['unowned_rows']} rows "
            f"({float(row['unowned_hours']):.1f} h) have no owner (e.g. C++ binaries)",
        )

    def check_ratios(self, sums: List[dict]) -> None:
        """8. Parallelism and overhead are in plausible ranges (informational)."""
        by_day: Dict[str, List[float]] = {}
        for r in sums:
            d = by_day.setdefault(r["d"], [0.0, 0.0, 0.0])
            d[0] += float(r["executed"])
            d[1] += float(r["held"])
            d[2] += float(r["occupancy"]) - float(r["no_report"])
        for day, (executed, held, reported) in sorted(by_day.items()):
            parallel = executed / held if held else 0.0
            overhead = 1 - held / reported if reported else 0.0
            status = "WARN" if parallel > 8 or overhead > 0.6 else "INFO"
            self.report(
                status,
                "8 ratios",
                f"{day}: {parallel:.2f} tests running at once while any ran (executed / held); "
                f"{overhead:.1%} of reporting jobs' wall time had no test running",
            )

    def run(self) -> int:
        checks: List[Tuple[str, object]] = [("1 freshness", self.check_freshness)]
        for name, check in checks:
            self.guard(name, check)
        sums = self.guard("table sums", self.table_sums)
        source = self.guard("workflow_job and ci.runs sums", self.source_sums)
        if sums is not None:
            self.guard("2 methods agree", lambda: self.check_methods_agree(sums))
            if source is not None:
                self.guard(
                    "3 totals match workflow_job",
                    lambda: self.check_totals(sums, source),
                )
            self.guard("4 row sanity", lambda: self.check_rows(sums))
            if source is not None:
                self.guard(
                    "5 no-report rows", lambda: self.check_no_report(sums, source)
                )
            self.guard("6 executed time", lambda: self.check_executed(sums))
            self.guard("7 owners", self.check_owners)
            self.guard("8 ratios", lambda: self.check_ratios(sums))
        return 1 if self.failed else 0

    def guard(self, name: str, fn) -> Optional[object]:
        try:
            return fn()
        except migrate.Failed as error:
            hint = (
                " (rerun with --sample N, or fewer days)" if error.code == 159 else ""
            )
            self.report("ERROR", name, f"{error}{hint}")
            return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--days", required=True, help="YYYY-MM-DD or YYYY-MM-DD:YYYY-MM-DD (inclusive)"
    )
    parser.add_argument("--repo", default="pytorch/pytorch")
    parser.add_argument(
        "--table",
        default="fortesting.test_cost",
        help="a table, or @file.sql holding a SELECT",
    )
    parser.add_argument(
        "--sample", type=int, default=0, help="keep jobs with cityHash64(id) %% N = 0"
    )
    try:
        return Checker(parser.parse_args()).run()
    except migrate.Failed as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
