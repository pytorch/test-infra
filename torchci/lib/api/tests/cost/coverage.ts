import { queryClickhouse } from "lib/api/tests/clickhouse";
import {
  addDays,
  COVERAGE_SEGMENTS,
  daysIn,
  JOB_SEGMENTS,
  type CostCoverage,
  type CostCoverageJobs,
} from "lib/api/tests/cost/contracts";
import type {
  CostCoverageJobsParams,
  CostCoverageParams,
} from "lib/api/tests/cost/parameters";
import {
  IN_SCOPE,
  latestDayRows,
  TEST_COST,
  withOwners,
} from "lib/api/tests/cost/query";
import { rankedNames } from "lib/api/tests/cost/scope";
import { CI_WORKLOAD_HEAVY } from "lib/api/tests/database";

const IN_RANGE = "day BETWEEN {from: Date} AND {to: Date}";

// The banner's test-job segments by day and runner label, each day as last
// computed: rows outside the workflow scope (out_of_scope), test jobs
// without test reports (no_reports), and for jobs with reports the time
// their test files ran (running: held time) and the rest of their time
// (setup_idle: occupancy less held, never below 0).
export function coverageTestsQuery(): string {
  return `
SELECT toString(day) AS day_utc, seg.1 AS segment,
  arrayStringConcat(runner_labels, ',') AS label,
  round(sum(seg.2) / 3600000, 4) AS runner_hours
FROM ${TEST_COST}
ARRAY JOIN multiIf(
    NOT ${IN_SCOPE}, [('out_of_scope', occupancy_runner_milliseconds)],
    test_file = '', [('no_reports', occupancy_runner_milliseconds)],
    [('running', held_milliseconds),
      ('setup_idle',
        toUInt64(greatest(occupancy_runner_milliseconds, held_milliseconds) - held_milliseconds))]
  ) AS seg
WHERE repo = {repo: String}
  AND ${IN_RANGE}
  AND ${latestDayRows(IN_RANGE)}
GROUP BY day_utc, segment, label
HAVING runner_hours > 0`;
}

// The scope's runner-hours of test jobs with reports, and of them those of
// test files with an owner (ci.owners, read now, as the drill joins them).
export function coverageOwnedQuery(): string {
  return `
WITH
  cells AS (
    SELECT test_file, sum(occupancy_runner_milliseconds) AS ms
    FROM ${TEST_COST}
    WHERE repo = {repo: String}
      AND ${IN_RANGE}
      AND ${IN_SCOPE}
      AND test_file != ''
      AND ${latestDayRows(IN_RANGE)}
    GROUP BY test_file
  )
SELECT round(sum(ms) / 3600000, 4) AS with_reports_h,
  round(sumIf(ms, NOT has(owner_list, 'unattributed:no_owner')) / 3600000, 4) AS owned_h
FROM (
  ${withOwners("cells").replace(/\n/g, "\n  ")}
)
SETTINGS join_use_nulls = 0`;
}

interface CoverageRow {
  day_utc: string;
  segment: string;
  label: string;
  runner_hours: number | string;
}

// Index tuples of day, segment and label rows: days ascending, labels most
// hours first, segments in the order given.
function compactSegments<S extends string>(
  rows: CoverageRow[],
  segments: readonly S[],
  days: string[]
): { labels: string[]; cells: [number, number, number, number][] } {
  const segmentIndex = new Map<string, number>(segments.map((s, i) => [s, i]));
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const kept = rows
    .map((r) => ({ ...r, h: Number(r.runner_hours) }))
    .filter(
      (r) => r.h > 0 && segmentIndex.has(r.segment) && dayIndex.has(r.day_utc)
    );
  const hours = new Map<string, number>();
  for (const r of kept) hours.set(r.label, (hours.get(r.label) ?? 0) + r.h);
  const labels = rankedNames(hours);
  const labelIndex = new Map(labels.map((l, i) => [l, i]));
  const cells = kept
    .map(
      (r) =>
        [
          dayIndex.get(r.day_utc) as number,
          segmentIndex.get(r.segment) as number,
          labelIndex.get(r.label) as number,
          r.h,
        ] as [number, number, number, number]
    )
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  return { labels, cells };
}

export function compactCoverage(
  rows: CoverageRow[]
): Pick<CostCoverage, "days" | "labels" | "cells"> {
  const days = Array.from(new Set(rows.map((r) => r.day_utc))).sort();
  return { days, ...compactSegments(rows, COVERAGE_SEGMENTS, days) };
}

export async function getCostCoverage(
  params: CostCoverageParams
): Promise<CostCoverage> {
  const workflows = params.workflow ?? [];
  const bound = { repo: params.repo, from: params.from, to: params.to };
  const started = performance.now();
  // Both read the range's days of test_cost once, about a second for a
  // month (query-validation.md): not heavy.
  const [rows, owned]: [
    CoverageRow[],
    { with_reports_h: number | string; owned_h: number | string }[]
  ] = await Promise.all([
    queryClickhouse(
      coverageTestsQuery(),
      { ...bound, workflows },
      "tests_cost_coverage"
    ),
    queryClickhouse(
      coverageOwnedQuery(),
      { ...bound, workflows },
      "tests_cost_coverage_owned"
    ),
  ]);
  return {
    repo: params.repo,
    workflows,
    from: params.from,
    to: params.to,
    ...compactCoverage(rows),
    with_reports_h: Number(owned[0]?.with_reports_h ?? 0),
    owned_h: Number(owned[0]?.owned_h ?? 0),
    query_duration_ms: Math.round(performance.now() - started),
  };
}

// The organization's job runner-hours by start day, repository segment and
// runner labels (sorted, comma-joined, as test_cost spells them), with
// test_cost_mv's job rules (000005): each job's latest version, completed
// and not skipped, on a runner, started no earlier than created, 0 to 24
// hours long. Jobs are picked through the started_at view first, since
// workflow_job is sorted by id; the repository is an alias over the URL,
// so it filters after the pick.
export function coverageJobsQuery(): string {
  return `
SELECT toString(toDate(started_at)) AS day_utc, repo,
  arrayStringConcat(arraySort(labels), ',') AS label,
  round(sum(dateDiff('millisecond', started_at, completed_at)) / 3600000, 4) AS runner_hours
FROM (
  SELECT repository_full_name AS repo, labels, status, conclusion, runner_name,
    created_at, started_at, completed_at
  FROM default.workflow_job
  WHERE id IN (
      SELECT id FROM materialized_views.workflow_job_by_started_at
      WHERE started_at >= {from: Date} AND started_at < {to: Date} + 1
    )
    AND started_at >= {from: Date} AND started_at < {to: Date} + 1
  ORDER BY _inserted_at DESC
  LIMIT 1 BY id
)
WHERE startsWith(repo, {org_prefix: String})
  AND status = 'completed'
  AND conclusion NOT IN ('skipped', '')
  AND runner_name != ''
  AND started_at >= created_at
  AND dateDiff('second', started_at, completed_at) BETWEEN 0 AND 86400
GROUP BY day_utc, repo, label
HAVING runner_hours > 0`;
}

interface JobsRow {
  day_utc: string;
  repo: string;
  label: string;
  runner_hours: number | string;
}

// The jobs rows as /coverage/jobs answers them: the repository's own
// (repo_all) and the organization's other repositories' (other_repos) hours
// by day and label, and how many repositories had jobs.
export function compactJobs(
  repo: string,
  rows: JobsRow[],
  days: string[]
): Pick<CostCoverageJobs, "repos" | "labels" | "cells"> {
  const sums = new Map<string, CoverageRow>();
  const repos = new Set<string>();
  for (const r of rows) {
    if (Number(r.runner_hours) <= 0) continue;
    repos.add(r.repo);
    const segment = r.repo === repo ? "repo_all" : "other_repos";
    const key = `${r.day_utc}|${segment}|${r.label}`;
    const row = sums.get(key) ?? {
      day_utc: r.day_utc,
      segment,
      label: r.label,
      runner_hours: 0,
    };
    row.runner_hours =
      Math.round((Number(row.runner_hours) + Number(r.runner_hours)) * 1e4) /
      1e4;
    sums.set(key, row);
  }
  return {
    repos: repos.size,
    ...compactSegments(Array.from(sums.values()), JOB_SEGMENTS, days),
  };
}

export async function getCostCoverageJobs(
  params: CostCoverageJobsParams
): Promise<CostCoverageJobs> {
  const org = params.repo.split("/")[0];
  const started = performance.now();
  // A heavy query: seconds of the jobs table a week (query-validation.md).
  const rows: JobsRow[] = await queryClickhouse(
    coverageJobsQuery(),
    {
      repo: params.repo,
      org_prefix: `${org}/`,
      from: params.from,
      to: params.to,
    },
    "tests_cost_coverage_jobs",
    false,
    CI_WORKLOAD_HEAVY
  );
  const range = { from: params.from, to: params.to };
  const days = Array.from({ length: daysIn(range) }, (_, i) =>
    addDays(range.from, i)
  );
  return {
    repo: params.repo,
    org,
    from: params.from,
    to: params.to,
    ...compactJobs(params.repo, rows, days),
    query_duration_ms: Math.round(performance.now() - started),
  };
}
