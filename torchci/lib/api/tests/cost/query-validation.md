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

| Version                                           | Server time | CPU-s | Rows read | Peak memory |
| ------------------------------------------------- | ----------- | ----- | --------- | ----------- |
| Latest day by `max(computed_at) OVER (PARTITION BY day)` (shipped) | 0.31 s      | 0.34  | 0.46 M    | 65 MiB      |
| Latest day by `(day, computed_at) IN (…)`         | 0.34 s      | 0.27  | 0.92 M    | 29 MiB      |

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
