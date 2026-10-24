# Tests API SQL validation

These notes describe the current implementation. Earlier experiments described
superseded endpoints, response shapes, defaults and generated statements; those
records are available in Git history. The specialized run and commit notes are
historical design records, not a check that today's SQL matches an old source hash.

Current bundled run and commit queries are validated separately in
[Attempt bundle SQL validation](test/runs/attempts-query-validation.md), with a
[dedicated replay script](../../../scripts/validateRunAttemptsQueries.cjs). Its
2026-10-24 evidence supersedes the older run-page SQL and timing records below.

## Current contract

The list defaults to `window=7d`, `ran_on=main`, `sort=-last_run_at` and `limit=25`.
It returns one row per test, environment and environment-variable set. The public
ID filters are `environments_id` and `env_vars_id`; IDs used for pagination ties
are not public sort choices. The generated OpenAPI document is the parameter
reference, including JSON encoding for `env_vars` and its accepted legacy bracket
syntax.

The detail endpoint has no window filter. It returns every retained health
window and code source for a test, ordered by environment ID, env-var ID, window
length, then code source. The `health.window` Enum8 codes increase with window
length: `3h`, `12h`, `1d`, `3d`, `7d`, `14d`. Order directly by the enum. Comparing
it to a string array with `indexOf` invokes numeric conversion and produces the
wrong order. A known test without health still returns its catalog identity and
owners, so the detail query must keep its catalog-first **LEFT JOIN**.

The list's **INNER JOIN** puts the aggregated health relation first and the
smaller catalog on the right. This changes the hash-table build side on the live
service's old analyzer. It does not change health aggregation, source selection,
workflow-path filtering or pagination. Preserve ordered health aggregation and
the existing exact distinct workflow-path union.

For one test's runs, the test catalog can use the already-bound test ID directly.
Commit runs still discover matching test IDs from their scoped runs. Both endpoints
paginate bundles by test, environment, environment-variable set and workflow job;
attempt filters select bundles and the full attempts fetch returns every execution
as `FINAL` would. Commit pages can group the `by_job` projection directly when
only immutable keys and minimum start time matter: duplicate versions cannot
change these groups or whether a rerun-number predicate matches. Outcome filters
and sorting by outcome, rerun number or end time require `FINAL`. Missing catalog
rows remain available when sorting unless an explicit filter excludes them.
Commit statistics still resolve replacement rows and count individual executions
for the entire repository/commit regardless of page filters.

## Reproduce the review validation

The checked-in evidence bundles contain each request, exact generated
baseline/candidate SQL and bound parameters, EXPLAIN plans, alternating execution
samples and complete-row equality digests. The
[2026-10-22 review](validation/review-2026-10-22.json) covers the list, detail and
test-runs queries; the [commit runs bundle](validation/commit-runs-2026-10-23.json)
covers the commit-runs pages and statistics. These
hashes describe the included generated strings or canonical result rows, not
TypeScript source files. The bundle records its database, server version and
measurement date. It contains no connection credentials.

From `torchci/`, with dependencies installed and Node 22:

```sh
node scripts/validateTestsApiQueries.cjs
node scripts/validateTestsApiQueries.cjs --live > tests-api-validation.json
```

The first command requires no database: it regenerates every candidate from the
current query builders and parsed request parameters, then checks SQL and bindings
against the bundles. It fails if the code or `CI_DATABASE` has changed; regenerate
and remeasure the affected evidence rather than assuming an old result still
applies. To limit a live rerun to one recorded case:

```sh
node scripts/validateTestsApiQueries.cjs --live detail > detail-validation.json
```

Live mode reads the normal `CLICKHOUSE_HUD_USER_*` environment variables or
`.env.local`. It runs read-only with query caching disabled, a 90-second timeout
and the server's memory limit, matching the original measurement settings.
Queries are sequential. Both variants receive
`EXPLAIN indexes=1` and `EXPLAIN PIPELINE`, then four alternating pairs with pair
order reversed on alternate iterations. Every execution must return nonempty,
exactly equal complete rows in the same order. The output contains new plans,
server timing/read counters and HTTP-reported memory, without credentials.

The detail baseline includes the requested correctness fix by explicitly casting
the enum to String inside `indexOf`. This gives the promised window order before
comparing it with the simpler enum ordering. The original broken ordering is
recorded separately as a reproduction, not used as an equality oracle. The list
and runs baselines precede their respective join/discovery optimizations.

Health refreshes atomically and runs expire or receive replacements. These are
live fixtures, not permanent snapshots. If rows change during comparison, the
runner fails; inspect the refresh timestamp/data change and repeat a comparison
on stable, nonempty parameters. Never discard a differing row or narrow the
retained time range to manufacture equivalence. Report timings that overlap as
noise, and retain the functional baseline if equality cannot be established.

## Review results (2026-10-22)

Every case returned exactly equal, ordered complete rows in all eight
executions (56 measured queries total). Values below are medians; memory and
rows-read counters use decimal units. The bundle contains every individual sample.

| Case                | Returned rows | Server seconds, before → after | Memory MB, before → after | Rows read (millions), before → after |
| ------------------- | ------------: | -----------------------------: | ------------------------: | -----------------------------------: |
| `detail`            |            82 |                  0.118 → 0.392 |               55.2 → 56.7 |                        0.123 → 0.123 |
| `main_default`      |            26 |                16.440 → 18.192 |            2951.0 → 744.5 |                      11.229 → 11.229 |
| `main_both_sources` |            26 |                45.705 → 13.240 |            4222.0 → 807.0 |                      25.580 → 25.580 |
| `main_filtered`     |            26 |                  0.782 → 2.411 |             202.1 → 156.0 |                      12.423 → 12.423 |
| `runs_filter`       |            26 |                  0.477 → 0.463 |             125.7 → 107.4 |                        1.574 → 0.788 |
| `runs_sort`         |            26 |                  0.091 → 0.090 |             113.2 → 122.4 |                        1.548 → 0.791 |
| `runs_filter_sort`  |             4 |                  0.183 → 0.243 |             113.5 → 105.7 |                        1.584 → 0.800 |

The original detail query returned windows out of order on a live configuration.
The corrected enum ordering matched the functional baseline's **82 complete
rows**, including every configuration/source/window, in all eight executions.
Timings overlapped; this is a correctness fix with no claimed latency gain.

For the default list request, all eight executions returned the same **26
complete rows** (25 plus lookahead) and read 11,228,524 rows. Reversing the inner
join reduced median HTTP-reported memory from **2.951 GB to 0.745 GB**. Baseline
server times ranged from 13.430–24.638 seconds (median 16.440); candidate times
ranged from 6.844–57.103 seconds (median 18.192). The latency variation does not
support a speedup claim. The change is retained for its consistent memory
reduction: every candidate used less memory than every baseline execution.

The filtered 14-day list fixture is a measured tradeoff: every candidate was
slower than its paired baseline, with median elapsed time rising from 0.782 to
2.411 seconds while memory fell from 202 to 156 MB. The common join order is
retained for the much larger memory reduction on default and both-source pages;
it is not a latency improvement for every request.

The three test-runs cases roughly halved rows read by removing the catalog's
redundant discovery scan. All returned rows remained equal, including a complete
four-row filtered result; timings showed no consistent improvement. The
corresponding commit query shapes were unchanged by that review; the commit runs
results below supersede them.

The both-source list baseline used up to 4.36 GB of reported memory; a lower
local query memory limit can prevent reproducing that baseline. See the bundle's
settings and individual samples when comparing a new run. No approximate
aggregates, narrower retention ranges or changes to replacement semantics were
introduced.

## Commit runs results (2026-10-23)

The commit-runs pages and statistics moved from a `FINAL` read of every partition
holding the commit's jobs to `by_job` reads resolved by replacement key. The
fixture is the 7,272,807 runs of `pytorch/pytorch` commit
`de09df22e85a661e656e93a476d614a1779d45f6`. Every case returned exactly equal,
ordered complete rows in all eight executions, and every candidate execution was
faster than every baseline execution. Values are medians; rows read in millions.

| Case                  | Request                                 | Returned rows | Server seconds, before → after | Rows read, before → after |
| --------------------- | --------------------------------------- | ------------: | -----------------------------: | ------------------------: |
| `commit_default`      | default                                 |            26 |                 11.678 → 1.048 |             816.2 → 133.2 |
| `commit_catalog_sort` | `sort=file,owner,-started_at`           |            26 |                 12.402 → 1.327 |            1506.6 → 141.5 |
| `commit_outcome`      | `outcome=failed`                        |            11 |                 13.573 → 1.793 |             816.2 → 140.9 |
| `commit_ended`        | `sort=-ended_at`                        |            26 |                  6.318 → 1.234 |             816.2 → 140.9 |
| `commit_rich`         | catalog and ID filters, outcomes, sorts |           101 |                 11.903 → 1.773 |            1506.6 → 148.9 |
| `commit_stats`        | statistics                              |             1 |                  4.953 → 0.852 |             816.2 → 133.4 |

The candidates move their per-key work into scalar subqueries, which the HTTP
summary's memory figure omits; [the commit notes](commit/query-validation.md)
record those measured on their own, with the further correctness checks.
