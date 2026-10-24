# Commit runs query validation

These are historical implementation measurements, not verification of the current
working tree. Their raw artifacts were not retained in the repository. For current
defaults, checked-in SQL evidence and the runnable validation procedure, see
[Tests API SQL validation](../query-validation.md).

This note covers run selection and pagination. The subsequent catalog expansion
is validated separately in [catalog-query-validation.md](../test/runs/catalog-query-validation.md).

Validated on 2026-10-22 using the working-tree SQL, not a deployed named query.
Local read-only ClickHouse credentials were used without logging credentials.

## Membership and replacement semantics

The commit identity is `default.workflow_run.head_sha` plus
`repository.full_name`. The SHA materialized view finds workflow IDs; all job IDs
attached to those workflows are included. There are no event, workflow-name,
conclusion, latest-attempt, or job-head-SHA filters. `IN` membership prevents
duplicate metadata updates from multiplying returned test runs.

The live `fortesting.runs` replacement key is
`(tests_id, environments_id, env_vars_id, started_at, github_workflow_job_id, rerun_number)`.
The query retains `FINAL` and applies outcome and cursor predicates after it.
Commit pagination adds `tests_id` to the shared ordering's identity tie breakers.

`FINAL` cannot use the `by_job` projection directly. The selected query discovers
every partition containing a matching job using that projection, then reads the
matching runs from those partitions with `FINAL`. Partition discovery has no
time cutoff. Both `started_at` and job ID belong to the replacement key, so the
prefilter includes every replacement of every eligible row.

## Fixed fixture and independent comparison

- Repository: `pytorch/pytorch`.
- SHA: `8caf0da8a5061291f1186f976bdbf7f8eda89ab1`.
- Matching workflow metadata supplied 587 distinct job associations, including
  workflow attempts 1 and 2.
- The unfiltered raw run lookup contained 5,114,349 rows and 580,424 distinct
  test IDs, with starts on 2026-10-13.
- The configuration with `environments_id=2081130751942693630` and
  `env_vars_id=5021553704861139757` contains 339 retained records across 339 tests:
  291 passed, 45 skipped, and 3 xfailed.

An independent reference froze the matching job IDs, discovered all test IDs for
that configuration through raw runs, and read their records from `runs FINAL`
across all retained dates. It used no partition or time bound. Its complete
339-record result matched every public field returned by the working-tree query.
For this unpaged SQL comparison only, the fetch parameter was raised to 1,000;
the public API limit remains 100.

The minimal functional query, applying workflow membership and the requested
filters directly to `runs FINAL` without discovery or partition pruning, was
also attempted. It timed out at 60 seconds. Equivalence to that full scan and a
speedup relative to it were **not** measured. The successful independent
339-record comparison uses exact test-ID discovery as described above.

## Optimization measurements

The initial executable baseline uses exact partition discovery. Two further
rewrites were tested: exact minimum/maximum start bounds derived from every
matching raw run, and discovery of complete replacement-key tuples followed by
`FINAL`. Each variant was explained with `EXPLAIN indexes=1` and
`EXPLAIN PIPELINE`, then measured in three alternating baseline/candidate pairs
with query caching disabled. Every returned column and row order matched in all
24 measured executions.

| Rewrite                        | Fixed request                     | Baseline median | Candidate median | Compared rows |
| ------------------------------ | --------------------------------- | --------------: | ---------------: | ------------: |
| Exact min/max                  | Default first page                |        2,401 ms |         2,240 ms |            26 |
| Exact min/max                  | Configuration, skipped or xfailed |        1,452 ms |         1,667 ms |            48 |
| Full replacement-key discovery | Default first page                |        2,409 ms |         7,409 ms |            26 |
| Full replacement-key discovery | Configuration, skipped or xfailed |        1,933 ms |         3,826 ms |            48 |

The default request includes one lookahead row. The filtered request returns its
entire 48-record result. Default baseline measurements varied from 967 to
3,438 ms, so the min/max difference was within run-to-run noise; it also read more
rows because it repeated the membership lookup. Full-key discovery was slower.
The partition baseline was retained and optimization stopped.

The retained query's outer plan selected 3,076 of 667,486 granules for the fixed
commit. Its discovery query used `by_job`, selecting 633 of 667,607 granules.
Totals vary as unrelated data is ingested. The pipeline retained replacement
processing and post-replacement filtering. No approximate functions were added
and no arbitrary time range was introduced.

## API and pagination checks

Actual `listCommitRuns` calls returned all 48 skipped/xfailed records in three
pages for each of `started_at`, `-started_at`, `ended_at`, `-ended_at`,
`-ended_at,started_at`, and `ended_at,-started_at`. All public fields matched the
independent reference, with no duplicate or omitted replacement keys. Responses
passed the shared run-page schema. Checks also covered default and single-outcome
filters, an absent outcome, unknown commits, another repository, and changing
page size while retaining the cursor scope.

Local HTTP checks verified a default 25-record page, the complete filtered result
in pages of 20 + 20 + 8, empty results for an unknown commit, 400 responses for an
invalid SHA, missing repository, or cursor from another repository, and 405 for
POST. At this stage, generated OpenAPI registered the path with `RunListPage`.
The catalog expansion now uses the shared `RunListPage` and `RunRecord` schemas
for both the test-runs and commit-runs endpoints.

The existing single-test runs SQL and parameters remained byte-for-byte equal
across the separate 48-case regression check; its query was not rewritten.

## Reuse commit membership within a request

After adding catalog and workflow filters/sorts, the named `matched_jobs` CTE
was expanded at every reference. The rich request below read approximately
1.086 billion rows, largely because each expansion repeated the same workflow
and job membership lookup. The default request repeated that lookup twice.

The retained rewrite computes `groupArray(id)` in a scalar subquery and uses
`IN (SELECT arrayJoin(matched_job_ids))` at each membership check. ClickHouse's
existing `enable_scalar_subquery_optimization=1` setting caches the scalar for
the current query. Every request still discovers current membership. There is
no application cache, extra request, new analyzer setting, or experimental
feature dependency. The tested server was ClickHouse `26.6.1.2326`, with the
existing analyzer disabled.

`groupArray` is exact and has no size cap here. It retains the source's signed
Int64 IDs and duplicate values; `IN` then removes duplicates, preserving the
original set semantics. No IDs pass through JavaScript numbers. The workflow
SHA and repository predicates, all workflow attempts, exact partition discovery,
`runs FINAL`, filters, sort expressions, cursor predicates and limit are unchanged.

Working-tree SQL was explained and compared with the preceding implementation
over four alternating pairs per fixture, reversing the order each pair. Query
caching was disabled. Every returned column and cursor sort value matched in
the complete ordered result on all 16 successful executions. One HTTP
connection failure was retried; it returned no timing and is excluded below.

Both fixtures use the repository and SHA above. The rich fixture additionally
uses the environment and environment-variable IDs above, outcomes `skipped`
and `xfailed`, limit `100`, and sort
`file,workflow_path,owner,device_count,outcome,rerun_number,-started_at`.

| Request                                            | Before median (range), seconds | After median (range), seconds | Rows read before / after      | Compared result rows |
| -------------------------------------------------- | ------------------------------ | ----------------------------- | ----------------------------- | -------------------: |
| Default first page, `sort=-started_at`, limit `25` | 3.290 (2.714–4.639)            | 1.621 (0.739–4.067)           | 281.6 million / 156.2 million |                   26 |
| Rich filters and sorts                             | 5.972 (3.762–8.002)            | 1.699 (1.221–1.917)           | 1.086 billion / 208.3 million |                   48 |

The default result includes one lookahead row; the rich result is the complete
matching set. Their canonical JSON SHA-256 values are respectively
`d76309275850e1d3ed0f01c43b6880dcc5318e9bfaed3d158023923b10ca3425`
and `ed6591af3cd0a859393eb88ed3846e1bfea510af131b013646a95df556285b19`.
These are SQL execution timings on a shared server, not guaranteed endpoint
latencies. Reported memory stayed within 86–99 MB for the rich rewrite, compared
with 86–120 MB for its baseline; default-request ranges were 49–72 MB and
40–89 MB respectively.

The retained `EXPLAIN indexes=1` still selects 6 run parts and 3,076 of about
672,000 run granules. Catalog discovery still selects the fixture's 339 test
IDs. `EXPLAIN actions=1` and `EXPLAIN PIPELINE` were also captured. Generated
working-tree SQL and bound parameters exactly matched the measured variant for
the default, timestamp-only filtered, and rich requests.

A second rewrite cached the exact partition dates in another scalar. Four
alternating rich-request pairs returned the same 48 rows, but its median
2.345 seconds (1.784–7.099) did not clearly improve on 2.613 seconds
(2.090–6.192) for job membership alone; it was slower in two pairs. The smaller
job-only rewrite was retained and optimization stopped. Materialized CTEs were
also explored successfully, but require an experimental setting; the retained
scalar approach obtains the membership reuse with existing production settings.

Additional live checks returned empty results for an all-zero SHA with
`sort=file,workflow_path,owner`, and for the real commit with an unmatched
environment ID. A small independent membership query checked duplicate IDs,
zero, negative one, and both signed Int64 bounds without truncation or duplicate
matches.

### Full data-fetch comparison

The combined change was also measured through actual `listCommitRuns` calls,
including the page query, catalog and workflow enrichment, mapping and cursor
encoding. Baseline modules came from the preceding commit; current modules came
from the working tree. Catalog and workflow requests now run concurrently.
These timings exclude HTTP routing and response transport; `query_duration_ms`
retains its existing sum-of-database-request-times meaning and can now exceed
elapsed wall time.

Four alternating pairs per fixture returned identical complete expanded records
and cursor tokens on all 24 calls. The repository and SHA were fixed as above.

| Request                                   | Before median (range), seconds | After median (range), seconds | Returned records |
| ----------------------------------------- | ------------------------------ | ----------------------------- | ---------------: |
| Default, limit `25`                       | 2.265 (2.128–2.459)            | 2.039 (1.566–3.284)           |               25 |
| `sort=file,owner`, limit `25`, no filters | 3.325 (3.184–5.521)            | 1.973 (1.743–2.068)           |               25 |
| Rich filters/sorts above, limit `100`     | 5.151 (4.688–10.336)           | 2.526 (2.083–3.982)           |               48 |

The catalog and rich requests improved clearly in this sample. The smaller
default-request difference was within observed variation; these measurements do
not establish a general speedup for every commit or request.

Final local HTTP checks passed for both run endpoints: all supported filters
and sort fields, complete pagination against an independently sorted 339-run
reference, shared OpenAPI parameters, empty commits and unmatched filters,
missing environment-variable keys, and rejection of changed-filter or
cross-endpoint cursors. All 744 API tests, TypeScript, lint and formatting checks passed; independent review found no issues.

## Initial total-only count (superseded by outcome stats below)

This section records the earlier total-only response and its validation. The
current response replaces top-level `total_runs` with the `stats` object described
below. At this stage, the commit page included `total_runs`. The count uses the same repository,
workflow SHA membership, exact partition discovery, replacement semantics and
all filters as its page. It counts individual retained runs, including reruns,
before the cursor or page limit; ordering does not affect the count. A shared
selection builder produces both queries. The existing page SQL and parameters
remain byte-for-byte unchanged, including all 568 parameter, cursor and query
regression cases exercised at that stage.

The functional baseline counts the original page query's complete filtered
selection, with no cursor or page limit. It retains the original selection joins
and sort projections. The optimized count removes ordering-only metadata joins
and projections, reusing the same filter predicates. Filtered catalog membership
uses the existing `IN` path; a workflow-path filter still selects the same latest
job and workflow metadata as page selection and expansion. `runs FINAL` and
`optimize_move_to_prewhere_if_final = 0` remain in place. No approximate aggregate,
time cutoff, cached response or experimental setting was introduced.

The working-tree baseline and candidate were explained with `EXPLAIN indexes=1`
and `EXPLAIN PIPELINE`, then timed in four alternating pairs per fixture, reversing
the order each pair, with query caching disabled. All 40 executions returned the
same exact count. The fixed repository, SHA and configuration are those above.
The rich ordering is `file,workflow_path,owner,device_count,outcome,rerun_number,-started_at`.

| Selection                                     | Exact count | Baseline median (range), seconds | Optimized median (range), seconds |
| --------------------------------------------- | ----------: | -------------------------------: | --------------------------------: |
| Entire commit, default ordering               |   5,114,349 |              0.832 (0.671–1.475) |               0.864 (0.600–1.476) |
| Configuration, default ordering               |         339 |              0.888 (0.795–1.710) |               1.003 (0.662–2.099) |
| Configuration, skipped/xfailed, rich ordering |          48 |              1.977 (1.838–2.542) |               0.859 (0.805–1.219) |
| Entire commit, rich ordering                  |   5,114,349 |              2.229 (1.611–4.501) |               0.985 (0.783–1.913) |
| Every filter family, rich ordering            |           1 |              3.691 (2.039–5.839) |               1.624 (1.541–2.091) |

The simple default and configuration differences were within run-to-run noise;
no improvement is claimed for them. Eliminating ordering-only metadata work
improved the rich selections. In the rich outcome-filtered case, rows read fell
from approximately 208.3 million to 156.2 million. With rich ordering across the
entire commit, reported memory fell from 240–254 MB to 29–46 MB. These are timings
of the added count query on a shared server, not a speedup over the previous
endpoint without a count.

Complete replacement-key rows were also compared, rather than only totals, for
the 339-run configuration, its 48 skipped/xfailed runs and the one-run selection
using every filter family. All matched exactly. The last fixture uses test
`2321863478197930947`, file `test/test_cuda_expandable_segments.py`, suite
`TestCuda`, case and declared case
`test_cuda_graph_allocator_propagates_stream`, language `python`, owner `cuda`,
the configuration's eleven environment fields, both environment-variable map
entries, workflow path `.github/workflows/trunk.yml`, outcome `skipped`, execution
number `0`, and exact search by case name. Full parameters and every compared row
are saved with the measurements.

Both default plans selected the same six run parts and 3,076 run granules, and
their pipelines retained replacement processing. The rich count eliminates
unneeded test, owner, environment and workflow sorting reads. When those fields
are used as filters, their selection remains: the all-filter candidate retains
the workflow lookup and uses exact catalog membership to prune the final run
read to five granules.

### Endpoint cost and HTTP verification

Actual `listCommitRuns` calls were also compared with the preceding implementation
without a count, using three alternating pairs per selection. Both selections use
limit `25`; the rich selection uses the configuration, outcomes and ordering
above. Every expanded run and cursor token matched across all 12 calls. These
timings include the concurrent count, page and enrichment requests, and exclude
HTTP routing and response transport.

| Selection                                     | Without count median (range), seconds | With count median (range), seconds |
| --------------------------------------------- | ------------------------------------: | ---------------------------------: |
| Entire commit, default ordering               |                   2.092 (1.686–2.714) |                1.605 (1.490–2.425) |
| Configuration, skipped/xfailed, rich ordering |                   2.431 (2.041–3.244) |                2.805 (2.199–6.319) |

The overlapping samples do not establish a latency improvement. Exact counting
adds database work and can increase response latency despite running concurrently.
The count and page are independent reads of current data; the response schema
documents that they may observe different data during updates. Individual
measurements and the comparison script are in `pipeline-benchmark.json` and
`pipeline-benchmark.cjs` under the same artifact directory.

Local HTTP checks confirmed counts of 339 and 48, unchanged totals across page
size and ordering changes, complete two-page traversal of the 48-run selection,
a positive total on an exhausted cursor page, and zero for unmatched filters.
The test-runs response remains unchanged, and OpenAPI requires `total_runs` only
on the commit page while reusing the existing run-record schema. All 755 API
tests, TypeScript, lint and formatting checks passed; independent review found
no issues. HTTP results are in `http-smoke.json` beside the benchmark artifacts.

## Initial outcome stats across the filtered selection (superseded below)

The initial outcome-stats response replaced top-level `total_runs` with `stats`. It contained
`total_runs` and one count for every recorded outcome: `unknown_runs`,
`passed_runs`, `failed_runs`, `error_runs`, `skipped_runs`, `xfailed_runs`,
`xpassed_runs`, `crashed_runs`, and `timed_out_runs`. These are disjoint exact
outcome buckets; for example, `failed_runs` counts only `outcome = 'failed'`, and
`passed_runs` counts successful attempts recorded as `passed`. Every bucket is
present, including zero values, and their sum equals `total_runs`.

Stats include all matching individual retained runs, including reruns, before
pagination. Every supplied filter, including `outcome`, applies to both the page
and stats. Ordering, cursor and page size do not affect stats. The stats and page
remain independent concurrent reads of current data, so they can differ during
ingestion, replacements or retention expiry.

The functional baseline is the preceding exact count SQL plus only the requested
outcome counts: `count()` and nine `countIf` expressions in one aggregation. The
outcome projection and response schema share a registry derived from the existing
run outcome enum. Generated SQL and parameters exactly match that baseline for
five fixed requests: default, configuration, rich outcome filters, sort-only, and
all filter families. Selection predicates, commit membership, exact partition
discovery, `FINAL`, and post-replacement outcome filtering are unchanged. Page SQL,
parameters and cursor behavior remain unchanged in the 568-case regression check.

A candidate first grouped the same selection by outcome, then combined its
at-most-nine rows using exact `sum` and `sumIf` aggregates. Both working-tree
variants were explained with `EXPLAIN indexes=1` and `EXPLAIN PIPELINE`, then timed
in four alternating pairs for each of the four selections below, reversing order
each pair. Query caching was disabled. All 32 executions returned the same complete
aggregate row, and every row's nine buckets summed to its total. The repository,
SHA, configuration and all-filter fixture are the same fixed fixtures above.

| Selection                      |     Total | One-pass baseline median (range), seconds | Grouped candidate median (range), seconds |
| ------------------------------ | --------: | ----------------------------------------: | ----------------------------------------: |
| Entire commit                  | 5,114,349 |                       0.659 (0.479–2.470) |                       2.529 (0.852–3.216) |
| Configuration                  |       339 |                       4.430 (0.859–7.861) |                       0.752 (0.679–4.562) |
| Configuration, skipped/xfailed |        48 |                       0.922 (0.645–2.294) |                       1.158 (0.722–1.622) |
| Every filter family            |         1 |                       1.895 (1.529–3.956) |                       2.059 (1.247–4.390) |

The configuration sample had large outliers on the shared server. A follow-up
four alternating pairs returned the same complete stats on all eight executions;
the one-pass median was 1.341 seconds (0.611–1.498), compared with 1.740 seconds
(1.365–2.712) for the grouped candidate. The candidate adds an aggregation stage,
regressed the full-commit request and showed no consistent advantage across
selections. The simpler one-pass functional baseline was retained and optimization
stopped. These comparisons do not establish a speedup over the preceding endpoint
that returned only a total.

Both default plans retained six run parts and 3,076 run granules; both all-filter
plans retained five run granules and the required workflow metadata lookup. No
approximate function, arbitrary time restriction or new experimental setting was
introduced. The full commit had 2,809,088 passed, 3 failed, 2,256,408 skipped and
48,850 xfailed runs; its other buckets were zero. The configuration had 291 passed,
45 skipped and 3 xfailed runs, matching the independently validated 339-run
fixture. Filtering to skipped/xfailed produced a total of 48, with passed reduced
to zero. The all-filter selection had one skipped run.

Live checks also confirmed a single all-zero aggregate row for an unknown commit
and a filter with no matching runs. A small read-only input containing one of each
outcome returned a total of nine and exactly one in every bucket, including the
outcomes absent from the fixed commit.

Final local HTTP checks verified the full 339-run and filtered 48-run outcome
breakdowns, unchanged statistics across cursor, limit and ordering changes,
nonzero statistics on an exhausted cursor page, and all zeros for unmatched
filters. Expanded run records and cursor tokens matched the preceding total-only
response. OpenAPI requires the shared `RunStats` object only on commit pages;
the test-runs response remains unchanged. All 765 API tests, TypeScript, lint and
formatting checks passed, and independent review found no issues. HTTP results
are in `http-smoke.json` in the same artifact directory.

## Commit-wide stats independent of page filters

Stats now cover every individual retained run associated with the requested
repository and workflow SHA, including reruns. Search, outcome, test, owner,
environment, environment-variable and workflow-path filters apply only to the
returned page. Cursor, limit and ordering also leave stats unchanged. An
unmatched page filter therefore returns an empty page with the same full-commit
stats; an unknown commit or a commit with no retained runs returns all zeros.
The existing outcome fields and independent concurrent-read semantics remain.

The stats builder accepts only repository and SHA. Its shared aggregate builder
receives only the endpoint scope, so passing a complete page request cannot
forward any page filter into the aggregation. Page selection still shares the
same scoped run read and retains all existing filters and sorting. Generated
page SQL and parameters matched the captured pre-edit queries exactly for six
requests: default, configuration, rich outcome filters, sort-only, every filter
family, and an unmatched outcome filter.

The broader 568-case regression snapshot also preserved page queries, parameter
handling and cursor bytes. OpenAPI response shapes remained unchanged; only
descriptions changed to explain the commit-wide stats scope. All 766 API tests
across 22 suites, TypeScript, lint and formatting checks passed.

The functional baseline is the preceding stats query with only repository and
SHA applied. All six working-tree stats queries and their bound parameters were
byte-for-byte identical to that unfiltered baseline. The exact commit membership,
cached scalar job-ID lookup, partition discovery, `FINAL`, single-pass `count()`
and `countIf` aggregates, and replacement-safe settings are preserved. The grouped
alternative measured above was slower for this same unfiltered SQL; the simpler
one-pass baseline remains, with no further SQL rewrite or claimed speedup.

Both baseline and working-tree SQL were explained with `EXPLAIN indexes=1` and
`EXPLAIN PIPELINE`. Both plans retained six run parts and 3,076 granules. Four
alternating pairs were timed for each request below, reversing order each pair,
with query caching disabled. All 32 complete aggregate rows matched exactly and
their outcome buckets summed to `total_runs`.

| Page request                   | Baseline median (range), seconds | Working median (range), seconds |
| ------------------------------ | -------------------------------: | ------------------------------: |
| Entire commit                  |              2.307 (0.734–3.299) |             0.992 (0.587–2.751) |
| Configuration                  |              1.146 (0.703–2.412) |             0.768 (0.484–1.413) |
| Configuration, skipped/xfailed |              0.823 (0.716–1.377) |             1.746 (0.958–2.528) |
| Every filter family            |              2.225 (0.764–4.075) |             1.073 (0.926–3.227) |

These are identical SQL statements on a shared server; the timing differences
reflect run-to-run variation, not an optimization. Every response counted
5,114,349 runs: 2,809,088 passed, 3 failed, 2,256,408 skipped and 48,850 xfailed,
with all other buckets zero. Independent queries of the original filtered
selections still returned 339, 48, 1 and 0 runs for the configuration, rich,
all-filter and unmatched-filter cases respectively. The unmatched-filter stats
still returned the full commit breakdown, and an unknown commit returned one
all-zero stats row.

Final local HTTP checks returned the same complete stats for unfiltered,
configuration-filtered, outcome-filtered, search-filtered and empty filtered
pages, as well as changed ordering, page size and continuation cursors. Unknown
commits and repositories returned zeros. Filtered run records and cursor tokens
matched the preceding implementation, and the test-runs endpoint remained
unchanged. Results are in `http-smoke.json` in the same artifact directory;
independent review found no issues.

## Concise stats field names

The statistics object now uses `total` and the nine recorded outcome names
(`unknown`, `passed`, `failed`, `error`, `skipped`, `xfailed`, `xpassed`,
`crashed`, `timed_out`), without the previous `_runs` suffix. The preceding
sections record earlier contracts; the current counts still cover the entire
repository and commit independently of page filters, ordering and pagination.

The working-tree SQL and bound parameters exactly match the preceding
commit-wide query after renaming only its ten output aliases. The single-pass
exact aggregates, scope, partition discovery, `FINAL`, and settings are
unchanged. The grouped rewrite rejected above remains unnecessary; there is no
new aggregation rewrite or claimed speedup.

Both versions were explained with `EXPLAIN indexes=1` and `EXPLAIN PIPELINE`,
then timed in four alternating pairs with query caching disabled. Pipelines
were identical. Both index plans selected six parts and 3,076 granules; only
the live table totals changed between EXPLAIN calls (108 to 109 parts and
676,501 to 676,502 granules). Baseline server duration was a median 0.812 seconds
(0.737–0.900), versus 0.753 seconds (0.503–0.946) after alias renaming. These
overlapping ranges reflect run-to-run variation.

All eight complete aggregate rows matched exactly after renaming baseline
keys: 5,114,349 total, 2,809,088 passed, 3 failed, 2,256,408 skipped and 48,850
xfailed, with the other five outcome buckets zero. Outcome counts summed to
the total in every execution. An unknown SHA returned one row with all ten
counts zero. Independent source and test review found no issues with field coverage, commit-wide scope or unrelated health fields.

Local HTTP checks confirmed the new keys, full-commit counts on a filtered page,
zero counts for an unknown commit, and matching OpenAPI properties. All 767 API
tests, TypeScript, lint and formatting checks passed. The 568-case comparison
preserved page SQL, parameters and cursors; only stats fields and their descriptions
changed in OpenAPI. HTTP results are in `http-smoke.json` beside the SQL artifacts.

## Read runs through by_job (2026-10-23)

At the full ingestion rollout a day partition holds about 680 million runs, and
one commit's runs touched 58.6% of its granules. Partition pruning therefore read
816 million rows per page and per statistics request: 7–14 seconds per page,
4–5 seconds for statistics, and about 11 seconds end to end for
`/api/tests/commit/de09df22e85a661e656e93a476d614a1779d45f6?repo=pytorch/pytorch`.
That commit's 7,272,807 runs fill 908 of 721,840 `by_job` granules.

The rewrite reads the commit's runs through `by_job` and resolves each run to its
`FINAL` version, as the [API README](../../../../app/api/README.md) describes.
A page sorted and filtered only on values a replacement keeps takes one key per
run from `by_job`, ordered and limited there, then reads those runs with `FINAL`
by primary-key prefix and full key. Pages that filter on outcome or sort by
outcome or end time, and the statistics, group the runs by test start. Starts
holding more than one stored run are read with `FINAL` and the rest directly.

### Correctness

Working-tree SQL was compared with the preceding implementation on the live
service. Sixteen request shapes returned exactly the same rows in the same order:
the default, every sort family (`ended_at`, `outcome`, catalog, environment and
workflow), every filter family, search and `limit=100`. So did thirteen second
pages, each continued from the first page's cursor. The fixture stores no
replacement key twice, but 44 test starts hold two distinct runs, so those runs
take the `FINAL` branch.

To exercise replacements, a local 26.10 server held a synthetic commit with the
live table definition and merges stopped: 560 stored rows for 468 keys, with
replacements holding two or three versions in separate parts, shared test starts
within and across the commit's jobs, and another commit and repository on the
same SHA. Under both analyzers, every page of eight paginated requests (316 pages
each) and the statistics matched the preceding implementation, whose `FINAL`
read served as the oracle.

The reads of one request see data at different moments. A key-ordered page
cannot repeat a run: `LIMIT 1 BY` keeps one key, and `FINAL` returns one version
of it. The statistics classify and count in one pass. A page grouped by test start
can return both versions of a run replaced between its reads; `queryRunsPage`
repeats the query then, and fails after three attempts rather than return a run
twice.

### Measurements

The [commit runs bundle](../validation/commit-runs-2026-10-23.json) records the
six cases summarized in [Tests API SQL validation](../query-validation.md):
medians fell from 4.95–13.57 to 0.85–1.79 seconds, and rows read from 816–1,507
million to 133–149 million, with equal rows in every execution. Actual
`listCommitRuns` calls, including expansion, alternated with the preceding
modules and returned identical pages, statistics and cursors: medians of
13.09 → 1.38 seconds for the default request and 10.72 → 2.06 seconds for
`outcome=failed`. Five further default calls, run alone, took 1.28–3.12 seconds.

The HTTP summary's memory figure omits scalar subqueries, which now hold the
per-key work. Run on their own, the page-key selection used 369–375 MB, the
shared-start detection 414–433 MB and the statistics classification 644–840 MB.
The main queries used 11–82 MB. The preceding queries used 37–570 MB for 5–22
seconds, so a default request now peaks near 1.1 GB, across its concurrent page
and statistics queries, for about a second.

### Alternatives measured

| Alternative                                                         | Result                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `DISTINCT` page keys                                                | 23 s and 6 billion rows: DISTINCT reads `tests_id` in sorting-key order      |
| `GROUP BY` or `DISTINCT` without in-order reading for page keys     | 0.71–0.98 s against 0.30–0.56 s for `LIMIT 1 BY`                             |
| Statistics from a replaced-key scalar and a `GROUP BY` of the rest  | 2.15 s against 1.08 s for one classifying pass                               |
| Classifying by full replacement key rather than test start          | 1.02–1.05 GB against 0.42–0.44 GB, at the same speed                         |
| `LIMIT 1 BY` on the grouped page                                    | 2.3–2.5 GB for `sort=-ended_at`, which loses top-N sorting; 52–63 MB without |
| Detecting shared starts only where a run matches the outcome filter | 1.22 → 1.00 s for `outcome=failed`, 1.29 → 3.18 s for `outcome=passed`       |
| Workflow lookups bounded by the commit's jobs rather than `by_job`  | 0.08–0.15 s faster pages, hidden by the longer parallel statistics           |
| Tuple-typed scalars, nested IN subqueries, predicate pushdown       | Fail on the old analyzer: 1,000,000-element field limit, AST size limit      |
