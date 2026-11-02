# Cost SQL validation

What `GET /api/tests/cost` costs the database, where the cost goes, and
evidence that its split of runner-hours is the owner breakdown it was built
from. Measured 2026-11-02 against production ClickHouse 26.6.1, through a
read-only database user. Server figures are from `system.query_log`
(`clusterAllReplicas`), matched on a marker comment per statement; CPU is user
plus system time. Every run was warm (first and second runs agreed within
noise), so there are no cold-cache numbers. There is no replay bundle yet.

Two cautions. That user runs 30 threads, so the heavy-profile figures
are the ones that predict production latency. And `ci.*` holds data from
2026-10-23 on, so some windows below had fewer days of `ci.runs` and
`ci.health` than their length.

## The runner-hours query

As shipped: the last 7 whole UTC days, owner shares from `ci.health`'s `7d`
window, the machine sample by `groupArraySorted`. Window 2026-10-26 to 11-01,
2,064 cells, 502 thousand runner-hours:

| Settings      | Server time | CPU-s | Rows read | Peak memory |
| ------------- | ----------- | ----- | --------- | ----------- |
| Heavy profile | 4.4 s       | 14.9  | 52.7 M    | 0.40 GB     |

Over other windows, measured while the window was a parameter (ending
2026-11-01, before the sample rewrite unless noted; second runs at 30
threads, and at 4 threads to approximate the profile):

| Window                | Server time | CPU-s     | Rows read | Peak memory | 4 threads: time, CPU-s |
| --------------------- | ----------- | --------- | --------- | ----------- | ---------------------- |
| 1d                    | 0.74 s      | 6.0       | 32.5 M    | 0.67 GB     | 2.2 s, 5.1             |
| 3d                    | 1.5 s       | 11.6      | 46.7 M    | 0.77 GB     | 3.2 s, 10.4            |
| 7d                    | 2.3 s       | 16.9      | 52.4 M    | 0.81 GB     | 5.2 s, 16.0            |
| 14d                   | 2.8–3.3 s   | 21.6–22.9 | 48.8 M    | 1.1 GB      | 6.3–6.4 s, 21.3–21.9   |
| 14d, rewritten sample | 1.6–1.7 s   | 19.9–20.6 | 48.8 M    | 0.84 GB     | profile: 5.1 s, 18.3   |

Wall time depends on the replica more than on the query: the same 14-day query
took 2.7–3.2 s on one replica and 6.7 s on a busier one, at about 22 CPU-s
either way.

**Heavy workload: tagged.** At 7 days the query is past the ten CPU-second bar
of [Heavy queries](../../../../app/api/README.md#heavy-queries), and the tests
assert the tag. Under the profile's caps it takes about 4 s of its 60 and
0.4 GB of its 8 GB; each request holds one of a replica's two heavy slots for
that long, so pages loading at once queue. The profile applied for that
user (`query_log` showed 4 threads, 60 s, 8 GB and the workload).

## Where the cost goes

Each common table expression was run on its own over 14 days, with the query's
`WITH` block verbatim and only the final `SELECT` replaced, computed columns
summed so none could be optimized away. Single warm runs before the sample
rewrite; the shares are by subtraction, so they are inferred:

| Piece                                                               | CPU-s | Share | 1d CPU-s |
| ------------------------------------------------------------------- | ----- | ----- | -------- |
| `machine_sample`, run twice (the `IN` set and the join)             | 9.8   | 45%   | 0.6      |
| `owner_shares`: `ci.health` joined to three dimensions, then owners | 5.1   | 23%   | 4.0      |
| `job_hours`' own `workflow_job` scan                                | 2.9   | 13%   | 0.2      |
| `ci.runs` read through `by_job`, and the label join                 | 2.2   | 10%   | 0.8      |
| `job_hours` join and aggregate                                      | 1.8   | 8%    | 0.2      |
| Final join to the shares, and grouping                              | 0.4   | 2%    | 0.25     |

`EXPLAIN indexes = 1, projections = 1`, 14 days:

| Read                           | Index                                              | Parts kept | Granules kept            |
| ------------------------------ | -------------------------------------------------- | ---------- | ------------------------ |
| `default.workflow_job`, ×3     | `started_at` minmax skip index                     | 5 / 14     | 634 / 32,546 (1.9%)      |
| `ci.runs`, projection `by_job` | primary key, `github_workflow_job_id IN` 1,316 ids | 85 / 109   | 2,137 / 1,085,714 (0.2%) |
| `ci.health`                    | partition on `window`                              | 10 / 57    | 2,446 / 11,998           |
| `ci.tests`                     | none (repo is not in the key)                      | 7 / 7      | 93 / 93                  |

`workflow_job` is read three times: by `job_hours`, and twice by
`machine_sample`, which ClickHouse does not materialize: once for the `IN` set
built at planning time and once as the join's right side. The `started_at`
index does all the pruning. `FINAL` on the dimension tables costs about 0.17
CPU-s and changes no rows; `GROUPING SETS` and the window function in
`owner_shares` cost 0.2 CPU-s or less.

## Rewrites tried

Each was timed alternating with the baseline and kept only if it returned the
same rows and beat run-to-run noise (about 4% of CPU between replicas).

- **Kept: the sample by `groupArraySorted`.** Each label keeps its 20 smallest
  `(cityHash64(id), id)` pairs as it reads, then `ARRAY JOIN`s them, instead
  of `ORDER BY cityHash64(id) LIMIT 20 BY label` over the window: the same
  jobs, duplicates of an unmerged job included. 14-day CPU went from 21.6–22.9
  (eight runs) to 19.9–20.6 (four), memory from 1.1 to 0.84 GB.
- **Rejected: reading the join's sampled jobs by primary key**
  (`workflow_job WHERE id IN (SELECT id FROM machine_sample)`). ClickHouse
  did not share the prepared set: 2.5 million more rows, 24.8 CPU-s against
  21.6.

## Equality

The query is an owner breakdown (runner-hours by owner and machine, the same
split) with each job's workflow kept. It was checked against that breakdown
and against plain workflow and machine breakdowns of the same jobs, queries
not shipped here. Over 14 and 1 days, both sides aggregated in one statement
and full-outer-joined on the key:

| Check                                                                  | Keys (14d, 1d) | Missing | Differing |
| ---------------------------------------------------------------------- | -------------- | ------- | --------- |
| Totals: these rows = owner = workflow = machine breakdowns             | –              | –       | ≤ 2e-10 h |
| Rows summed by owner = the owner breakdown                             | 74, 74         | 0       | 0         |
| Rows summed by workflow = the workflow breakdown, case-folded          | 176, 106       | 0       | 0         |
| Rows summed by machine = the machine breakdown                         | 18, 18         | 0       | 0         |
| Rows by owner, machine and unmapped label = the owner breakdown's rows | 1,300, 1,021   | 0       | 0         |
| Rows with the rewritten sample = before it, every row                  | 3,382, 2,358   | 0       | 0         |

## Machines and families

`machinesQuery()` names each machine's family from `ci.environments` columns:
the accelerator when the machine has a device, else its OS's CPUs, with the
catalog's labels. On 2026-11-02 it returned 18 machines in five families,
CUDA (6), Linux CPU (5), ROCm (4), MPS (2) and Windows CPU (1), in 5 ms. A new
accelerator, device or OS shows up under its own name with no code change.

## Time to signal

| Window | Server time | CPU-s   | Rows read | Peak memory |
| ------ | ----------- | ------- | --------- | ----------- |
| 1d     | 0.09 s      | 0.24    | 107 K     | 0.24 GB     |
| 14d    | 0.38 s      | 3.0–3.4 | 1.88 M    | 1.2–1.8 GB  |

Well under the bar; not tagged.

## Next: a rollup, and mappings generated on a schedule

The fixed 7 days stand in for a date range. The query's inputs that expire,
`ci.runs` (14 days) and `ci.health` (rolling windows), and the per-request
guesses (the label sample) belong in a daily rollup in `ci`, built by a
refreshable materialized view, so the API reads stored days instead:

- **The rollup:** each day's runner-hours by repository, workflow, owner key,
  machine and runner label, appended once a day for the last few days (late
  reports), readers taking each day's latest computation. A date range is then
  a cheap sum, and history outlives `ci.runs`.
- **Mappings it generates rather than code holding them:** the runner label to
  machine map, from all of a day's test jobs rather than 20 sampled per
  request (later the exact machine per job); and owner shares per day, from
  that day's test time, which also makes the per-workflow owner split exact.
  What stays as rules is what the data carries: families from
  `ci.environments`, short names from the devices present, and, until job
  kind is read from whether a job uploaded reports, the test job name pattern.
- **Cost to measure first:** a day of `ci.runs` is up to 1.7 billion rows, so
  the per-day owner split is a heavy query to run once a day, not per request;
  measure it in `fortesting` before any production refresh.
