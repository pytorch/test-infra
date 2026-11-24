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

`trendQuery` and `trendDailyQuery` carry the runner-hours of pushes to
main beside the whole (`sumIf(…, trigger = 'push:main')`), for
cost per commit. Over 10-29..11-04:

- The trend's rows are those of the query before the change (8,329 rows,
  447,041.09 h, no row differs); its push:main hours by day are the
  table's above. Server time 0.53 s against 0.54 s (median of 6, within
  noise).
- The daily totals fold rows outside the workflow scope into one 0 h row a
  day (`label` ''), so a day with data is a day the rollup holds, not a day
  the scope ran: for `periodic`, the same 74 cells and 4,101.86 h, plus 7
  zero rows.

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

## Scope, series, coverage, coverage/jobs, cases

Measured 2026-11-19/20 through `hud_user` (`readonly=2`, 8 GB, `max_execution_time` 120,
the database's old analyzer), server figures from `FORMAT JSON` statistics, `max_threads` 1
(the CPU-seconds proxy) and 4, alternating runs, medians of 3. `ci.test_cost` held
pytorch/pytorch from 2026-10-29 (22 days), so the 28v28 and 365-day cases read the same
rows as 21 days: **re-measure once the rollup holds 90 days or more.**

### One builder for `/scope` and `/series` (`scopeQuery` in `scope.ts`)

Rows: each day as last computed (`latestDayRows`), the workflow scope, summed first by
side and piece (or day), then joined to machines and owners. Machine = the environment's,
else the runner label's machine that ISO week (`weekLabelMachines`: argMax over the
reporting rows of the whole weeks that touch the days, so any window over a week agrees),
else Unknown machine. The baseline is the straightforward form: every key
(side|day, piece, week, file, environment, label, workflow) pre-grouped, owners joined and
ARRAY JOINed first, then both machine joins, pill filters last. The shipped form keeps only
the keys the scope needs (no owner join without an owner pill or `by=o`, no machine joins
without a machine pill or `by=m`) and joins machines before owners. Same rows on every
case (0 differing; the baseline's 2 extra series rows hold 0 h):

| Query                            | Days              | Shipped 1 thr / 4 thr (ms)            | Baseline 1 / 4 (ms) | Rows read (shipped / base) | DB rows out |
| -------------------------------- | ----------------- | ------------------------------------- | ------------------- | -------------------------- | ----------- |
| scope by=o root                  | 7v7               | 383 / 261                             | 1,039 / 504         | 3.89 M / 8.72 M            | 4,700       |
| scope by=o root                  | 28v28             | 487 / 334                             | 1,205 / 613         | 4.76 M / 10.08 M           | 5,886       |
| scope by=o root                  | 365v365           | 483 / 352                             | 1,163 / 569         | 4.76 M / 10.08 M           | 5,886       |
| scope by=m at o:inductor         | 7v7               | 907 / 464                             | 998 / 566           | 8.72 M / 8.72 M            | 155         |
| scope by=m at o:inductor         | 28v28             | 1,005 / 527                           | 1,229 / 597         | 10.08 M                    | 191         |
| scope by=m at o:inductor         | 365v365           | 1,056 / 509                           | 1,218 / 556         | 10.08 M                    | 191         |
| scope by=f at inductor × avx512  | 7v7               | 873 / 431                             | 1,013 / 550         | 8.72 M                     | 1,902       |
| scope by=f at inductor × avx512  | 28v28             | 1,044 / 508                           | 1,241 / 618         | 10.08 M                    | 2,323       |
| scope by=f at inductor × avx512  | 365v365           | 1,032 / 524                           | 1,248 / 570         | 10.08 M                    | 2,323       |
| scope by=m root                  | 7v7 / 28v28 / 365 | 518 / 408, 653 / 398, 699 / 309       | —                   | 8.72–10.07 M               | 241–297     |
| series by=o root                 | 14 d              | 520 / 310                             | 1,290 / 718         | 3.89 M / 8.72 M            | 15,894      |
| series by=o root                 | 56 d              | 722 / 388                             | 2,218 / 756         | 4.76 M / 10.08 M           | 23,995      |
| series by=o root                 | 365 d             | 733 / 489                             | 2,151 / 775         | 4.76 M / 10.08 M           | 23,995      |
| series by=m at o:inductor        | 14 / 56 / 365 d   | 1,171 / 421, 1,556 / 623, 1,460 / 591 | —                   | 8.72–10.08 M               | 519–779     |
| series by=f at inductor × avx512 | 14 d              | 940 / 448                             | 1,278 / 567         | 8.72 M                     | 6,359       |
| series by=f at inductor × avx512 | 56 d              | 1,390 / 595                           | 1,829 / 741         | 10.08 M                    | 9,481       |
| series by=f at inductor × avx512 | 365 d             | 1,325 / 588                           | 1,983 / 700         | 10.08 M                    | 9,481       |
| days + pushes (`scopeDaysQuery`) | 7v7 / 28v28 / 365 | 1,164 / 315, 958 / 272, 1,257 / 331   | —                   | 4.7–5.1 M                  | 14–21       |

EXPLAIN (`indexes = 1`): test_cost prunes on `(repo, day)` to 239 of 308 granules (the table
is 332 granules in all); the label machines read the whole weeks (297 of 308). The pushes
read `default.push` by subcolumns, a full read of three small columns as the trend's pushes
do (3,926 granules, about a second on one thread). Nothing reaches a CPU-second and a half
on one thread: not heavy.

Answers through the dev server (bytes as JSON, wall time warm): scope by=o root 120 KB 0.4 s
(7v7), 150 KB (28v28 and 365); by=f pair 62–70 KB 0.5–0.7 s; by=m at inductor 7.7 KB 0.5 s;
by=lane at one file 5.6 KB 0.5 s; series by=o root 364 KB (14 d), 555 KB (56 d and 365 d)
0.3–1.2 s; by=m at inductor 14–20 KB; by=f pair 34–49 KB (30 files + rest). A year of days
at today's ~1,100 owner × label cells a day would be about 400 K series cells (~10 MB) at
the root; the page reads `/trend` there.

### Baseline equivalence (live, absolute dates)

- `/trend` without `periods`: the SQL `/trend`, `/changes` and `/cost` send is
  identical to main's builders before this change (compared in jest), and `periods=42`
  returns the same periods and cells as no `periods`. `periods=366` returns 366 periods (2025-11-19..2026-11-19, 650 KB, 0.55 s);
  `periods=401` is a 400.
- `/scope?by=o&a=2026-11-05..2026-11-11&b=2026-11-12..2026-11-18`: A 50,708.9 and B 43,869.0
  h a day, equal to `/changes` (every owner) to 0.0000%.
- inductor: its root row (14,426.74 → 11,795.25 h a day) equals the sum of its machines;
  inductor × Linux x86_64 avx512 (7,210.80 → 4,842.36) equals the sum of its 154 files;
  test_flex_attention.py's file row (1,986.824 → 743.944 h) equals the sum of its 8 lanes.
- `/series?trail=&by=o` over 2026-10-09..2026-11-19 equals `/trend?rollup=day` cell by cell
  (25,212 owner × label × day cells, 0 differing, max |diff| 0); days, pushes and filling
  equal the trend's.
- `/series` by=m at `o:inductor` over 2026-11-12..18 equals `/scope` by=m at `o:inductor`
  side B (41 machine × label keys, max |diff| 0.0002 h: per-piece against per-day rounding).
- `m:Linux x86_64 avx2`: `/scope` by=o 62.45 → 62.70 h; `/series` 133.24 h over 21 days.

### `/coverage` and `/coverage/jobs`

`coverageTestsQuery` arrayJoins each latest row into its segment (running = held,
setup_idle = occupancy − held, never below 0, as UInt64; no_reports; out_of_scope);
`coverageOwnedQuery` sums the scope's hours with reports and those of owned files. Over
B = 2026-11-12..18: running 172,204, setup and idle 84,581, no reports 50,299 h; Σ =
307,083.0 h = `/changes` B to 0.0000%; owned 97.4% of 256,785 h with reports. Server
0.10–0.47 s on one thread for 7 to 365 days: not heavy.

`coverageJobsQuery` applies test_cost_mv's job rules (latest version by `_inserted_at`,
completed, not skipped, on a runner, started ≥ created, 0–86,400 s) to jobs picked through
`materialized_views.workflow_job_by_started_at` (EXPLAIN: 743 of 33,550 granules of
workflow_job), grouped by day, repository and label (the browser's segments are folded in
Node). B slice of the 14-day window: org 458,405 h in 21 repos, pytorch/pytorch 368,707,
other repos 89,698; repo − tests = 61,624 h, never negative on any (day, label) pair. Shares:
other repos 19.6%, builds/lint/other 13.4%, no reports 11.0%, setup and idle 18.5%, running
37.6%; the page = 67.0%.

| Window  | 4 threads (3 runs)   | 1 thread | Rows read | Bytes read |
| ------- | -------------------- | -------- | --------- | ---------- |
| 7 days  | 2.42 / 2.30 / 2.36 s | 3.53 s   | 7.6 M     | 430 MB     |
| 14 days | 5.09 / 4.92 / 5.96 s | 9.20 s   | 15.3 M    | 872 MB     |
| 28 days | 9.49 / 9.55 / 9.32 s | 14.14 s  | 30.5 M    | 1.72 GB    |

14 days stays under 10 s at 4 threads, so `JOBS_WINDOW_DAYS` stays 14. Tagged heavy: the
endpoint accepts 28 days (14 server seconds on one thread) and finishes well inside 60 s at 4 threads.
Two rewrites were tried against the shipped form, alternating, same 3,468 rows each:
argMax per id instead of `ORDER BY _inserted_at DESC LIMIT 1 BY id` (4.34 / 4.07 / 4.66 s vs
5.10 / 4.73 / 4.57 s), and argMax plus a URL-prefix filter before the dedup, the repository
extracted once per job (4.61 / 6.55 / 4.75 s vs 4.80 / 4.87 / 4.94 s). Neither beats
run-to-run noise, so the form that mirrors test_cost_mv stays.

### The cases gate

`ci.runs` is sorted by `(tests_id, environments_id, …)` and partitioned by day. A file's
tests are hashes spread over every part, so the scan reads every granule holding one of
them in each covered day's parts, whatever the environments: EXPLAIN ESTIMATE gives the
same 1,119,024,178 rows for test_flex_attention.py on Linux x86_64 avx512 (10 environments)
and on NVIDIA H100 (1). **One environment costs as much as all of them** ("Try one
environment" saves nothing); fewer days do (B alone reads 0.48× of 13 days). Rows read
(EXPLAIN ESTIMATE = the scan's rows read) against the file's distinct tests in `ci.tests`,
13 covered days (2026-11-06..18):

| File                                                          | Tests       | Rows (estimate) | Model        | Scan at 4 threads                  |
| ------------------------------------------------------------- | ----------- | --------------- | ------------ | ---------------------------------- |
| test/test_futures.py                                          | 23          | 19 M            | 34 M         | —                                  |
| test/inductor/test_foreach.py                                 | 682         | 355 M           | 359 M        | —                                  |
| test/test_dlpack.py                                           | 1,016       | 465 M           | 475 M        | —                                  |
| test/nn/test_pooling.py                                       | 1,268       | 543 M           | 555 M        | —                                  |
| test/inductor/test_cpu_repro.py (avx512)                      | 1,325       | 575 M           | 572 M        | **19.8 s** (576 M read, 34 ns/row) |
| test/test_ops_jit.py                                          | 2,307       | 847 M           | 843 M        | —                                  |
| test/inductor/test_flex_attention.py (avx512)                 | 3,437       | 1.12 G          | 1.12 G       | **27.7 s** (H100: 19.3 s)          |
| test/test_fx.py                                               | 3,897       | 1.26 G          | 1.22 G       | —                                  |
| test/functorch/test_aotdispatch.py                            | 5,066       | 1.53 G          | 1.46 G       | —                                  |
| test/functorch/test_vmap.py                                   | 7,636       | 1.99 G          | 1.95 G       | —                                  |
| test/inductor/test_torchinductor.py (avx512)                  | 9,265       | 2.27 G          | 2.24 G       | **58.9 s** (26 ns/row)             |
| test/inductor/test_torchinductor_dynamic_shapes.py            | 11,367      | 2.55 G          | 2.57 G       | —                                  |
| test/test_ops_gradients.py / test_sparse.py / test_modules.py | 13.1–13.5 K | 2.88–2.95 G     | 2.85–2.90 G  | —                                  |
| test/test_decomp.py (avx512)                                  | 36,405      | 5.10 G          | 5.82 G       | not run (> 120 s predicted)        |
| test/test_ops.py (avx512, L4, A10G)                           | 188,568     | 9.52 G          | 10.9 G (cap) | **A10G: timed out at 120 s**       |

Model (`CASES_GATE`): rows = days × min(835 M, 44 M × (tests / 1,325)^0.7), within 5% of
every estimate above 600 tests and conservative below; seconds = 1 + rows × 34 ns (the
slowest rate measured). The gate passes a scan predicted at 45 s or less: test_cpu_repro
(20 s predicted, 19.8 measured) and test_flex_attention (39 s, 27.7) pass; test_torchinductor
(77 s predicted, 58.9 measured) is too big over 13 days and passes for B alone (42 s);
test_decomp and test_ops are too big for any week (test_ops passes for one day). Every scan
measured under 45 s passes. The gate itself (`casesGateQuery`: the file's lanes from
test_cost, its distinct tests from ci.tests) runs 0.08–0.31 s at 4 threads and reads no
runs. Live: test_ops.py × avx512 answers too_big in 0.73 s; test_cpu_repro.py × avx512
answers ok in 16.2 s (17 configurations, 400 cell rows of 8,696 cells).

The scan (`casesScanQuery`) names the runs once, explicit columns, `GROUP BY GROUPING SETS
((side, tests_id, environments_id, env_vars_id), (side, environments_id, env_vars_id))`,
then window functions rank cells by |B a day − A a day| and by B. It runs in the heavy
workload. It reads the runs without `FINAL`, as the commit summary's counts do: for 40 of test_cpu_repro.py's tests over 2026-11-12..18, 226,816 rows held 226,816 distinct sort keys (no duplicates waiting for a merge). A two-pass alternative (find the jobs from a few tests, then read the file's
tests through the `by_job` projection) was considered and not built: a job's tests are
hashes interleaved across files, so the projection would read whole jobs. The lossless fix
is a daily test-case rollup or `env_vars_id` in test_cost.
