# Tests API SQL validation

These notes describe the current implementation and point at the checked-in
evidence for each query family. Each bundle ships with a replay script under
`scripts/`; run without `--live` it regenerates every recorded case from the
working-tree builders and fails when the SQL or bindings differ, so a query
change must regenerate and remeasure the affected evidence rather than assume an
old result still applies. `yarn test` runs every replay this way
(`test/scripts/validateQueries.test.ts`), so a stale bundle fails the suite
instead of waiting to be run by hand. The specialized notes beside the queries
record design experiments; their measurements are historical.

| Queries                                            | Evidence and replay script                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests list, boundary probe, test detail            | [query-validation.json](query-validation.json), `scripts/validateTestsApiQueries.cjs`                                                              |
| Run bundles, attempt fetch (test and commit pages) | [attempts-query-validation.md](test/runs/attempts-query-validation.md), `scripts/validateRunAttemptsQueries.cjs`                                   |
| `last_attempt_outcome` filter                      | [last-attempt-outcome-query-validation.md](test/runs/last-attempt-outcome-query-validation.md), `scripts/validateLastAttemptOutcomeQueries.cjs`    |
| Commit pages reading `FINAL` only at shared starts | [commit/query-validation.md](commit/query-validation.md), `scripts/validateCommitSharedStartsQueries.cjs`                                          |
| Commit statistics: bundles by final outcome        | [commit/query-validation.md](commit/query-validation.md), `scripts/validateCommitStatsQueries.cjs`                                                 |
| Previous-page cursors                              | [bidirectional-pagination-query-validation.md](bidirectional-pagination-query-validation.md), `scripts/validateBidirectionalPaginationQueries.cjs` |
| Workflow metadata lookup                           | [workflow-query-validation.md](test/runs/workflow-query-validation.md), `scripts/validateRunWorkflowQuery.cjs`                                     |
| Runs grouped by commit (`group_by=commit`)         | [grid-query-validation.md](test/runs/grid-query-validation.md), `scripts/validateRunGridQuery.cjs`                                                 |
| Run detail by execution UUID                       | [run/query-validation.md](run/query-validation.md)                                                                                                 |

## Current contract

The list defaults to `window=12h`, `ran_on=main`,
`sort=-status,-failure_rate,-failed_runs,-last_failed_at,-skip_rate,-mean_passed_duration_milliseconds`
(the Health header's chain, worst first, so a bare page opens on the failing
tests) and `limit=25`.
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
and sorting by outcome, rerun number or end time need replacement resolution;
since 2026-10-24 a commit page reads `FINAL` only at the test starts holding more
than one stored row and the rest through `by_job`, as the statistics do (see the
[commit notes](commit/query-validation.md)). Missing catalog
rows remain available when sorting unless an explicit filter excludes them.
Commit statistics count bundles by final outcome for the entire
repository/commit regardless of page filters: one `by_job` pass groups the
commit's rows by job and test, counts the keys holding one stored row directly,
and resolves only the other keys' rows before grouping them into bundles.

## Reproduce the list and detail validation

The list and detail queries have no before/after comparison: their evidence is a
current-SQL fixture. [query-validation.json](query-validation.json) records each
request, the exact generated SQL and bound parameters, the cursors taken from
live pages the way the API builds them, `EXPLAIN indexes = 1` and
`EXPLAIN ESTIMATE` plans, three executions with server timing, rows read and
memory, and complete-row digests. It records the database, server version and
measurement date, and no credentials.

From `torchci/`, with dependencies installed and Node 22:

```sh
node scripts/validateTestsApiQueries.cjs
node scripts/validateTestsApiQueries.cjs --live > tests-api-validation.json
node scripts/validateTestsApiQueries.cjs --live detail > detail-validation.json
```

The first command needs no database. Live mode reads `CLICKHOUSE_HUD_USER_*`
from the environment or `.env.local`, runs read-only with the query cache
disabled and a 90-second timeout, and requires every execution of a case to
return the same nonempty complete rows. Health refreshes every 15 minutes and
replaces every row, so a list page can change between executions; the runner
then fails, and the comparison is repeated rather than relaxed. Cursor cases
embed the recorded cursor and expire with the entries they point at; record a
new cursor from a live page rather than editing one.

## List and detail results (2026-10-26)

Every case returned the same nonempty complete rows in all three executions on 2026-10-26 against `ci` on ClickHouse 26.6.1.2439. Memory is the HTTP summary peak; rows read include the catalog joins. Health granules are the final primary-key selection within the partitions `window` and `ran_on` prune.

| Case                  | Request                                                                                                                                                    | Rows | Server seconds, median (range) | Rows read, millions | Memory MB | Health granules |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | -----------------------------: | ------------------: | --------: | --------------: |
| `main_default`        | defaults: `window=12h`, `ran_on=main`, `sort=-status,-failure_rate,-failed_runs,-last_failed_at,-skip_rate,-mean_passed_duration_milliseconds`, `limit=25` |   26 |            5.004 (4.644–5.254) |                10.2 |       884 |             1/1 |
| `main_both_sources`   | `ran_on=main,pull_request`                                                                                                                                 |   26 |           5.396 (5.166–11.925) |                15.8 |       896 |             1/1 |
| `main_filtered`       | `owner=nn`, `accelerator=cuda`, `window=14d`, `sort=-failed_runs,-runs`                                                                                    |   26 |            1.054 (0.721–1.115) |                10.6 |       149 |             1/1 |
| `main_search`         | `search=test/test_nn.py`                                                                                                                                   |   26 |            0.611 (0.602–0.670) |                10.2 |       164 |             1/1 |
| `main_env_vars`       | `env_vars={"TEST_CONFIG":["default"]}`, `window=1d`, `sort=file,suite,case_name`                                                                           |   26 |            6.808 (6.320–6.937) |                10.6 |      1211 |             1/1 |
| `main_second_page`    | defaults continued from the first page cursor                                                                                                              |   26 |            5.000 (4.712–5.024) |                10.2 |       882 |             1/1 |
| `main_boundary_probe` | previous-direction probe the second page issues, one row                                                                                                   |    1 |            4.629 (4.472–4.747) |                10.2 |       784 |             1/1 |
| `detail`              | test `12347295505799784290`                                                                                                                                |  278 |            0.076 (0.073–0.413) |                 0.1 |        26 |             1/1 |

The default page aggregates the whole `(main, 12h)` partition, 8.33 million health rows on 2026-10-26 (half of them configurations whose every attempt in the window was skipped, which is why the 12 hour partition is nearly as large as the 7 day one, 8.73 million), and sorts it by the six-field health chain before taking 26 rows, so its cost is the partition size rather than the page; the boundary probe a cursor page issues runs the same aggregation for one row and costs a comparable amount. Catalog filters, search and the env-var set shrink the aggregation and run in 0.6 to 6.8 seconds. The detail query prunes health to 12 granules through its test ID.

## History

On 2026-10-25 the default sort changed from `-last_run_at` to
`-mean_passed_duration_milliseconds`, slowest passing tests first. The five
cases that leave `sort` off, `main_default`, `main_both_sources`,
`main_search`, `main_second_page` and `main_boundary_probe`, were
re-recorded, the two cursor cases from fresh live pages, and the whole bundle
re-measured; this file's history holds the 2026-10-24 bundle. The new default
reads and plans exactly as the old one did: `EXPLAIN indexes = 1` and
`EXPLAIN ESTIMATE` for the two default pages are identical line for line, and
both read 10.5 million rows. The three cases whose SQL did not change ran 1.4
to 1.8 times slower than on 2026-10-24, so the day's load, not the sort,
accounts for the higher figures above. Alternating the two default pages
three times each once the 19:00 refresh had landed gave medians of 7.1
seconds for the old sort and 6.2 for the new (6.1–7.9 against 6.0–7.2), the
same 10.5 million rows read, and 952 against 969 MB.

Later on 2026-10-25 `search` changed from an exact, case-sensitive match on
any of file, suite, case name and declared case name to a match anywhere in
the test's node id, `file::suite::case_name` with an empty suite left out,
ignoring ASCII case (`searchPredicateSql` in `shared-sql.ts`, shared with the
runs endpoints), so a page can search names as they are typed. `main_search`
was regenerated and re-measured. For its request, `search=test/test_nn.py`,
the old and new queries have identical `EXPLAIN indexes = 1` and `ESTIMATE`
plans, read the same 10.5 million rows (`ci.tests` is ordered by id alone, so
either predicate scans the whole catalog) and return the same 26 rows;
alternating runs gave medians of 0.97 seconds for the exact match and 0.82 for
the new one, at 140 against 139 MB.

Two earlier bundles under `validation/` were removed on 2026-10-24 because they
generated `fortesting.` SQL for builders that have since changed; commit
3226fefe3 holds them. Their conclusions, which still shape the queries:

- 2026-10-22 review of the list, detail and test-runs queries: the detail
  query's window ordering was corrected to order by the enum, the list's
  `INNER JOIN` was reversed to put the aggregated health relation first, cutting
  median memory on the default page from 2.95 GB to 0.75 GB with latencies
  overlapping (the filtered 14-day page got slower, 0.78 to 2.41 seconds, and
  was accepted for the memory reduction), and the test-runs queries dropped a
  redundant catalog discovery scan, halving rows read. Every case returned equal
  rows in eight alternating executions.
- 2026-10-23 commit runs: pages and statistics moved from a `FINAL` read of
  every partition holding the commit's jobs to `by_job` reads resolved by
  replacement key; medians fell from 4.95 to 13.57 seconds to 0.85 to 1.79
  seconds on a 7.27-million-run commit with equal rows. The commit notes keep
  the design record; the shared-start section at their end records the current
  form of the pages that need replacement resolution.
- 2026-10-26 default page: the default window changed from `7d` to `12h`
  and the default sort from `-mean_passed_duration_milliseconds` to the
  Health header's chain,
  `-status,-failure_rate,-failed_runs,-last_failed_at,-skip_rate,-mean_passed_duration_milliseconds`,
  which gained `-last_failed_at` and the mean at its end at the same time, so
  that a bare page opens on what is failing now. On main that night the
  health table held 20 failing and 32 flaky configurations in the 12 hour
  window against 137 and 152 over 7 days, and only 20 of the 137 had failed
  within the last 12 hours, 109 having only been skipped since. The five
  cases that leave `sort` and `window` off were re-recorded, the two cursor
  cases from fresh live pages walked through the local API (the second page
  shared no row with the first, and its previous cursor returned the first
  page's rows exactly, with `last_failed_at` deciding millisecond ties and
  the passing mean NULL on the rows without a pass), and the whole bundle
  re-measured; the table above is that run. The ORDER BY is the functional
  change, so there is no equivalent baseline to show; the SQL is otherwise
  unchanged and the plans still prune to one partition. Alternating the old
  default (`window=7d&sort=-mean_passed_duration_milliseconds`) and the new
  one through the local dev server three times each gave 5.4–6.3 seconds
  against 5.0–5.1 wall time: the `(main, 12h)` partition holds 8.33 million
  rows against 8.73 million, so the gain is small and the cost remains the
  partition aggregation.
