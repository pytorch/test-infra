# Cost SQL validation

What `GET /api/tests/cost` costs the database, and evidence that its
runner-hours are the jobs' wall time. Measured 2026-11-04 against production
ClickHouse 26.6.1 through a read-only database user, while the rollup
`fortesting.test_cost` held 2026-11-01 to 11-04. Server figures are from
`system.query_log` (`clusterAllReplicas`), matched on a `log_comment` per run;
CPU is user plus system time. Every run was warm.

## The runner-hours query

`runnerHoursQuery()` over 2026-11-01 to 11-03 (3 days), 3,617 rows, 168,921
runner-hours, four runs alternating with the previous version of the query:

| Version                                                            | Server time | CPU-s | Rows read | Peak memory |
| ------------------------------------------------------------------ | ----------- | ----- | --------- | ----------- |
| Latest day by `max(computed_at) OVER (PARTITION BY day)` (shipped) | 0.31 s      | 0.34  | 0.46 M    | 65 MiB      |
| Latest day by `(day, computed_at) IN (…)`                          | 0.34 s      | 0.27  | 0.92 M    | 29 MiB      |

The shipped form reads `test_cost` once per reference of `latest` (two:
`label_machines` and `test_rows`) instead of twice each; the difference in
time is within noise. Both filter on the table's sort-key prefix, `(repo,
day)`. Client wall time, network and JSON included, was 1.0–1.2 s for 1 day
and 1.1–1.3 s for 7 days (which held 3). At about 0.3 CPU-seconds the query is
far below the heavy workload's bar ([Heavy
queries](../../../app/api/README.md#heavy-queries)), so it runs without it.
`coverageQuery()` takes about 0.3 s of client wall time.

Rolled up to (owner, workflow, runner label), the shipped query's rows equal
the previous version's exactly on these days (2,205 groups, 0 differing), and
no runner label's estimated machine changed: summing a label's reporting hours
by machine rather than by environment (one machine spans many environments)
changes nothing here, but picks the right machine where one machine's
environments together outweigh another machine's single environment.

## Totals against `workflow_job`

`test_cost` is checked against test jobs' wall time in `default.workflow_job`
(latest version of each job, the rollup's job rules, workflow path from
`default.workflow_run`) by day and workflow path, computed at 03:30 UTC on
2026-11-04:

| Day   | Workflow paths | Within rounding | Table      | `workflow_job` |
| ----- | -------------- | --------------- | ---------- | -------------- |
| 11-01 | 50             | 50              | 22,154.2 h | 22,154.2 h     |
| 11-02 | 51             | 51              | 54,971.9 h | 54,971.9 h     |
| 11-03 | 52             | 50              | 91,794.9 h | 91,807.8 h     |

Rounding is 0.5 ms per stored row. The two 11-03 paths that differ are fully
explained: two XPU nightly jobs that finished after the computation (42,805 s)
and one pull job whose row reached `workflow_job` after it (3,793 s). The next
refresh picks both up.

## Against HUD's cost analysis

HUD's cost analysis page (`duration_job_per_workflow_name`) reads
`misc.runner_cost`, which a lambda fills from `workflow_job` by the day jobs
completed, for jobs whose first runner label is in its price map. Over
2026-11-01 to 11-03, test jobs only (job names matching `test (`, builds
excluded):

| Workflow   | HUD (test jobs) | `test_cost` | Difference |
| ---------- | --------------- | ----------- | ---------- |
| pull       | 80,406 h        | 80,310 h    | 0.1%       |
| trunk      | 49,726 h        | 50,344 h    | −1.2%      |
| inductor   | 22,908 h        | 22,740 h    | 0.7%       |
| slow       | 3,164 h         | 3,260 h     | −2.9%      |
| rocm-mi300 | 1,934 h         | 2,016 h     | −4.1%      |
| xpu        | 65 h            | 3,702 h     | not priced |
| All        | 164,714 h       | 168,921 h   | −2.5%      |

XPU accounts for 3,637 of the 4,207 hours of difference: `linux.idc.xpu` is
not in the lambda's price map. Bucketed the same way (by completion day),
HUD's daily test hours are 1.3–1.9% below `workflow_job`'s, the price map's
coverage again. Single days differ more than the window (11-02: 49,757 h
against 54,972 h) because HUD buckets jobs by the day they completed and
`test_cost` by the day they started. HUD names workflows by display name
(`inductor-perf-nightly-h100`), the page by file name
(`inductor-perf-test-nightly-h100`); the workflows only one side names hold
1,730 and 1,692 hours.

## The move to `ci.test_cost`

Measured 2026-11-05/06 through `hud_user` (`readonly=2`, `max_threads=8`,
`max_memory_usage=8e9`, `max_execution_time`), server figures from
`X-ClickHouse-Summary`, alternating runs. `ci.test_cost` (000004/000005)
adds the `trigger` column; it holds 2026-10-29 on, a day after
`fortesting.test_cost` began. Every whole day both hold sums to the same
runner-hours, each day as last computed:

| Day   | `ci.test_cost` | of it `push:main` | `fortesting.test_cost` |
| ----- | -------------- | ----------------- | ---------------------- |
| 10-29 | 87,853.5 h     | 16,487.4 h (19%)  | 87,853.5 h             |
| 10-30 | 78,904.9 h     | 19,421.8 h (25%)  | 78,904.9 h             |
| 10-31 | 34,410.4 h     | 8,400.1 h (24%)   | 34,410.4 h             |
| 11-01 | 22,154.2 h     | 5,831.6 h (26%)   | 22,154.2 h             |
| 11-02 | 54,971.9 h     | 11,072.9 h (20%)  | 54,971.9 h             |
| 11-03 | 91,880.0 h     | 17,986.9 h (20%)  | 91,880.0 h             |
| 11-04 | 76,866.2 h     | 14,131.0 h (18%)  | 76,866.2 h             |

Every query sums both triggers into its runner-hours, so the move changes
no figure; `test/api/tests/cost/query.test.ts` keeps the SQL on the ci
table's columns.

## The trend and what changed

`trendQuery`, `trendDailyQuery` and `changesQuery` carry the runner-hours of
pushes to main beside the whole (`sumIf(…, trigger = 'push:main')`), for
cost per commit. Over 10-29..11-04:

- The trend's rows are those of the query before the change (8,329 rows,
  447,041.09 h, no row differs); its push:main hours by day are the
  table's above. Server time 0.53 s against 0.54 s (median of 6, within
  noise).
- The daily totals fold rows outside the workflow scope into one 0 h row a
  day (`label` ''), so a day with data is a day the rollup holds, not a day
  the scope ran: for `periodic`, the same 74 cells and 4,101.86 h, plus 7
  zero rows.

`changesQuery(true)` for inductor, A 10-29..11-01 against B 11-02..11-04,
against the straightforward form (the latest day by a window function and
the owners joined on every row): the same 4,830 rows (0 differing), median
0.87 s against 1.63 s over 5 rounds, 1.0 s against 1.9 s on one thread,
53 MiB against 97 MiB. Its sides sum to the trend's inductor hours to
0.0005 h (64,344.2 h and 65,308.0 h). With the push:main hours added and
the trigger cut dropped, the file and workflow rows are unchanged and their
push:main sums equal the old trigger breakdown's; 0.56 s against 0.44 s
(medians of 6, ranges overlapping). About a CPU-second for a week a side:
not a heavy query.

## Pushes to main

Pushes per day come from `default.push`: distinct head commits pushed to
`main` (or `master`), by the head commit's timestamp, which for a merge is
when it landed. They equal the distinct `head_sha` of push:main runs in
`workflow_run` on every day checked (10-29..11-04: 70, 76, 33, 23, 48, 69,
58). Read for a year (309 days, 14,518 pushes, the same in every form):

| Form                                                         | Rows read | Bytes read | Memory  |
| ------------------------------------------------------------ | --------- | ---------- | ------- |
| `head_commit.'timestamp'`, `repository.'full_name'` (prunes) | 0.69 M    | 2.8 GB     | 1.8 GiB |
| `repository.full_name`, `head_commit.'timestamp'` (prunes)   | 0.69 M    | 2.8 GB     | 540 MiB |
| `repository.full_name`, `head_commit.timestamp` (shipped)    | 2.65 M    | 138 MB     | 160 MiB |

The quoted form prunes by the sort key but reads whole tuples; the
subcolumns read every row of three small columns, about a second.

## Days still filling

The view recomputes the last days every 3 hours from 00:30 UTC, so the day
just ended is first whole after midnight. Of the test jobs that started on
11-02 and 11-03, the wall time of those finishing after 00:30 the next day
was 4.9% and 2.2%; after 03:30, 0.18% and 0.09%; after 06:30, 0.03%. A day
last computed before 03:00 the next day (`FILLING_HOURS`, 27 hours after it
began) is filling: the trend lists it, fades its bar, keeps it out of the
presets and says it reads low.
