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
conclusion or latest-attempt filters. Since 2026-11-03 the jobs are read
through the job table's `head_sha` view, which holds the same jobs because a
job's `head_sha` is its run's (see that day's section below). `IN`
membership prevents duplicate metadata updates from multiplying returned test
runs.

The live runs table's replacement key (then `fortesting.runs`, now `ci.runs`, same definition) is
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

Historical: this section describes the per-run page design of 2026-10-23. Attempt
bundling later replaced the page-key read with the grouped page, and `queryRunsPage`
has no retry; the section on shared test starts at the end records the current
form. The commit-runs evidence bundle this section cites was removed on 2026-10-24
because it generated `fortesting.` SQL for superseded builders; commit 3226fefe3
holds it.

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

The commit runs bundle of 2026-10-23 (removed on 2026-10-24, see the note at the
top of this section; commit 3226fefe3 holds it) recorded six cases, summarized in
the history note of [Tests API SQL validation](../query-validation.md):
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

## Grouped pages read FINAL only at shared test starts (2026-10-24)

A commit page whose filters or ordering need replacement resolution (`outcome`,
`last_attempt_outcome`, or sorting by `ended_at`, `outcome` or `rerun_number`)
read `ci.runs FINAL` filtered by job ID. A job filter prunes neither the primary
key nor the partition key, so that read covered every retained granule: 24,605
of 24,605 on the fixture below, 201.5 million rows, and it grew with every
retained day. The default page and the statistics already avoided this through
`by_job`.

The page now resolves replacements the way the statistics do. Versions of one
run share its replacement key, so they share its test start `(tests_id,
started_at)`. One `by_job` pass lists the starts holding more than one stored
row; a `FINAL` read pruned to those starts deduplicates them, and every other
row is read directly through `by_job`. The union feeds the unchanged `GROUP BY`,
`HAVING`, catalog and workflow joins, cursor predicate and ordering, and reads
only the group keys plus the attempt columns the grouping uses. The test route,
whose `FINAL` read is pruned by its primary key, and the `by_job` default page
and statistics are byte-identical before and after; the bundle records them
under `unchanged`.

The shared-start set is an inline `IN` subquery, not a `WITH` scalar. The first
attempt held it in the `WITH` clause next to `matched_job_ids`; the old analyzer
copied that clause into every nested subquery and the request failed with `AST
is too big. Maximum: 500000`. The inline set is cheap to copy because it
references only the job-ID scalar.

Validated on 2026-10-24 against `ci` on ClickHouse 26.6.1.2439 with SQL from the
working-tree builders, read-only, query cache disabled, 90-second timeout. The
fixture is `pytorch/pytorch` commit `97a3cf652accf801225a2a05b5b3ab19b4d65473`:
9,984,566 stored rows across 1,006 jobs, 28 shared test starts holding 56 rows.
Each case ran `EXPLAIN indexes = 1` and `EXPLAIN ESTIMATE` for both versions,
then four alternating pairs with the order reversed on alternate pairs. Every
execution returned exactly equal complete rows, including cursor values, and
every after execution was faster than every before execution. Values are
medians of server seconds; bytes are decimal GB from the JSON statistics.

| Case                       | Request                                                                                                                    | Rows | Before → after seconds | Bytes read before → after |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---: | ---------------------: | ------------------------: |
| `commit_outcome_failed`    | `outcome=failed`                                                                                                           |   10 |          4.141 → 1.805 |               9.33 → 3.97 |
| `commit_last_passed`       | `last_attempt_outcome=passed`                                                                                              |   26 |          7.135 → 3.108 |              14.21 → 4.21 |
| `commit_ended_sort`        | `sort=-ended_at`                                                                                                           |   26 |          3.992 → 1.560 |              10.76 → 4.04 |
| `commit_outcome_sort`      | `sort=outcome,-started_at`                                                                                                 |   26 |          6.399 → 2.962 |              14.20 → 4.21 |
| `commit_rerun_sort`        | `sort=-rerun_number,-started_at`                                                                                           |   26 |          6.379 → 3.137 |              14.00 → 4.20 |
| `commit_rich`              | `outcome=skipped`, `rerun_number=0`, `last_attempt_outcome=skipped`, `accelerator=cuda`, `sort=-ended_at,file`, `limit=10` |   11 |          5.461 → 1.761 |              14.38 → 4.09 |
| `commit_last_passed_page1` | `last_attempt_outcome=passed`, `limit=5`                                                                                   |    6 |          6.417 → 2.941 |              14.21 → 4.21 |
| `commit_last_passed_page2` | the same request continued from the first page's cursor                                                                    |    6 |          6.603 → 2.827 |              14.21 → 4.21 |

`EXPLAIN indexes = 1` shows the after plan reading `by_job` for 1,254 of 24,605
granules and `ci.runs FINAL` for 238 of 13,647 granules after partition pruning
to 9 of 20 parts; `EXPLAIN ESTIMATE` falls from 201.5 million to 12.2 million
runs rows. Memory is unchanged: about 0.37 GB for the outcome filter and
2.1 GB wherever `argMax` over the chronology tuple runs, before and after.

The `rows_read` counter rose from 328.6 million to 410.2 million despite the
smaller runs read because the old analyzer evaluates the `matched_job_ids`
scalar once per query block that references it: once for the whole request
before, and once per union branch now. Measured alone, that scalar scans
125.6 million `default.workflow_job` rows in 0.20 seconds and 1.0 GB, one
`by_job` pass over the commit reads 10.3 million rows, and the shared-start
classification 0.44 seconds. The after counter is three scalar evaluations plus
three by_job passes and the pruned `FINAL` read: each union branch builds its own
shared-start set, and the direct branch reads by_job once more. That overhead is about 0.4
seconds and 2 GB per request and does not grow with runs retention; the `FINAL`
scan it replaces did. Binding the job IDs from a first application-side request
would remove the repeated evaluations and is left as a follow-up.

The classification set and the two union reads take their parts snapshots at
slightly different moments within one request. A version inserted in that window
at a start that was unique when classified is read without `FINAL` by the direct
branch until the next request; the previous single `FINAL` read had one snapshot,
and the statistics query has always classified and read separately. The window
is milliseconds and needs a re-ingested report, and returned attempts are still
fetched with `FINAL`.

The commit cases of the [attempt bundle](../test/runs/attempts-query-validation.md)
and [last-attempt filter](../test/runs/last-attempt-outcome-query-validation.md)
evidence that used the full `FINAL` read were regenerated from the working tree
and remeasured on the same date; their other comparison side is unchanged.

From `torchci/`, with dependencies installed and Node 22:

```sh
node scripts/validateCommitSharedStartsQueries.cjs
node scripts/validateCommitSharedStartsQueries.cjs --live > shared-starts-validation.json
```

The first command regenerates every case from the builders and checks it
against [the evidence](shared-starts-query-validation.json), including the
unchanged test-route, default-page and statistics SQL. Live mode repeats the
plans and alternating comparisons with `CLICKHOUSE_HUD_USER_*` from the
environment or `.env.local`; fixtures expire under the 14-day TTL, so an empty
result means choosing a new commit, not relaxing the comparison.

On 2026-11-03 every case's before became the query the page ran until that
day, with the old job lookup, and its after the query with the new one (see
the 2026-11-03 section below): the full `FINAL` baseline reads every
partition, which took 4 to 8 s on the one-day-old table of 2026-10-24 and
over four minutes on 2026-11-03, past the replay's 90-second limit. Each
replaced baseline had been shown equal to the full one when its case was
last recorded; the git history holds those recordings.

## Statistics count bundles by final outcome (2026-10-24)

The statistics counted individual executions, so a test that failed and then
passed on retry counted once as failed and once as passed. On
`pytorch/pytorch` commit `ce7558288b3d701e32c6789e28b826897d8a0b5c` they
reported 8 failed, 13 crashed and 8 timed-out executions while every bundle
holding a failed or crashed execution ended with a pass. The statistics now
count bundles, the unit the page paginates: one per test, environment, env var
set and GitHub job, under its final outcome.

The final outcome is the outcome of the bundle's chronologically last executed
attempt, in the `started_at`, `ended_at`, `toString(id)` order the attempts list
and the `last_attempt_outcome` filter use, or `skipped` when every attempt was
skipped. A skip never overrides an executed attempt. The commit's retried
bundles motivated that rule: of its 3,123 bundles with several attempts, 1,834
were `passed,passed`, 997 `skipped,skipped`, 154 `skipped,passed`, 81
`passed,skipped`, 18 and 12 five-fold repetitions, 7 `crashed,passed`, 6
`failed,crashed,passed`, 2 `timed_out,passed`, 2 `failed,passed`, 1
`xfailed,xfailed`, and 6 `timed_out,skipped`. Those six are `test_flex_decoding`
tests that hung for the 30-minute limit and were then skipped by their own skip
condition when `run_test.py` reran them alone; the harness logged them as
flaky successes, but the test never passed, and the health view's retry chains
count a chain ending in a skip after a failure as a failure. Reading the
recorded last attempt would turn those timeouts into skips, so the statistics
report them as `timed_out`. Only this case separates the final outcome from the
`last_attempt_outcome` filter, which was left reading the recorded last attempt.

Recomputing both rules in Python from that distribution and the execution
counts reproduces the SQL exactly: 7,268,182 bundles (7,271,410 executions less
3,228 extra attempts), 3,241,706 passed, 3,970,214 skipped, 56,256 xfailed, 6
timed out, and no failed or crashed bundle. The recorded-last-attempt rule
would give 3,241,625 passed, 3,970,301 skipped and no timeouts.

### Query

Grouping every retained run of the commit into bundles needs replacement
resolution for mutable outcomes, and a `GROUP BY` over 7.27 million bundles with
`argMax` over the chronology tuple took 1.5 to 1.9 seconds and 1.4 GB on the
shared-start source the pages use. Bundles with several stored rows are rare,
so the retained query splits the work by job and test, the two bundle identity
columns that lead the `by_job` projection order. One `by_job` pass groups the
commit's rows by that key: a key holding one stored row is a one-attempt bundle
in its only version and is counted per outcome from that pass, inside an
array-of-one-tuple scalar like the earlier classification. Only the other keys'
rows, pruned by key on `by_job`, are read as `FINAL` would return them: grouped
by test start, the starts holding one stored row come straight from `by_job`
through `any()`, and the starts holding more are read with `FINAL` pruned to
those starts. Those rows are then grouped into bundles and counted under their
final outcome. The keys partition the rows, so no bundle is counted twice. The
`by_job` projection stores every version, and the pass counts stored rows, so a
key with two versions of one run is classified as holding several rows and
resolved, never counted twice.

The functional baseline is the commit's retained runs read with `FINAL` and
grouped into bundles with the same final outcome, with no pruning beyond the job
filter. Four alternating pairs per case with query caching disabled returned
identical complete rows in every execution, and every working-tree execution
was faster than every baseline execution on both commits. Values are server
seconds; memory is the HTTP summary peak, which omits scalar subqueries, so the
working-tree figure excludes its first pass: measured alone as a top-level
query, that pass took 0.38 seconds and 770 MB on the first commit.

| Case               | Bundles   | Baseline median (range) seconds | Working median (range) seconds | Rows read, millions | Bytes read GB | Summary memory MB |
| ------------------ | --------- | ------------------------------: | -----------------------------: | ------------------: | ------------: | ----------------: |
| `commit_ce7558288` | 7,268,182 |             5.335 (5.112–5.882) |            0.999 (0.970–1.016) |         341 → 134.1 |  15.03 → 1.17 |     1,104 → 23–34 |
| `commit_97a3cf65`  | 9,980,119 |             5.594 (5.491–5.628) |            1.140 (1.032–1.311) |         341 → 136.8 |  15.03 → 1.21 |     2,113 → 21–23 |
| `unknown_commit`   | 0         |             0.059 (0.053–0.067) |            0.541 (0.487–0.564) |       0.008 → 0.008 |         0 → 0 |             5 → 5 |

Rows read include the 126 million `default.workflow_job` rows of the membership
scalar in both versions. `EXPLAIN ESTIMATE` of the main query falls from 19
parts, 214 million rows and 26,183 marks to 2 parts, 466,944 rows and 57 marks
on the first commit (the first pass runs inside the scalar and is not
estimated). `EXPLAIN indexes = 1` shows the pruned reads using `by_job` with the
`(github_workflow_job_id, tests_id)` set of 3,123 and 4,340 keys, and the
`FINAL` branch pruning its partitions and primary key by the shared starts,
which were empty for both commits at measurement time: the versions that made
28 starts shared the day before had been merged away. An unknown commit is the one case that got slower: the previous statistics
SQL answered it in 0.04–0.05 seconds and the new one takes about 0.5 seconds.
Timing the new query's pieces on that SHA attributes 0.09 seconds to the
scalars, 0.12 to the direct branch and 0.25 to the `FINAL` branch with its
inline shared-start subquery, although every set is empty and 8,201 rows are
read in total; each additional query block and `IN` subquery costs tens of
milliseconds under the old analyzer even when it reads nothing. A
`notEmpty(multi_row_keys)` guard on the second pass did not remove it (0.56
seconds) and slowed the real commit to 1.17–1.48 seconds, and dropping the job
filter from the second pass, whose key set already implies it, took 0.73
seconds there against 0.92–0.98 versus 0.97–1.11 seconds on the real commit,
within noise; neither was adopted. The endpoint's page query runs concurrently,
so an unknown commit still answers in under a second.

Rejected rewrites, each returning the same rows: grouping every row into bundles
over the pages' shared-start source, 1.5–1.9 seconds and 1.4 GB; the same with
the UUID instead of its string in the chronology tuple, unchanged; computing the
pruned shared starts once in an array scalar instead of twice inline, 2.2–2.3
seconds; `optimize_aggregation_in_order = 1` for the first pass, 15–19 seconds,
because the planner then reads the base table in primary-key order instead of
the projection.

The commit list's `stats` field, its builder (`buildRunStatsQuery`),
`scripts/validateCommitStatsQueries.cjs` and its evidence file were removed on
2026-11-02: the summary endpoint carries the commit's counts by status, and no
page read the field. The sections above record how the statistics were
measured while they existed.

## Rare-outcome filters read a pruned FINAL (2026-10-30)

The commit page's sections are the API's `status` filter (`section` until
2026-11-01), a bundle status after replacement resolution (`failed`,
`timed_out`, `flaky`, `passed`, `other`, `xfailed`, `skipped`;
`BUNDLE_STATUS_SQL` in `lib/api/tests/test/runs/query.ts`). A status, like an
`outcome` or `last_attempt_outcome` filter, needs every attempt of a bundle,
so until now any of them took the grouped read above: by_job for the keys
holding one stored row, `FINAL` at the shared test starts for the rest, two
scans of the commit's rows.

When every bundle the filters admit must hold at least one row with a rare
outcome (anything but `passed` and `skipped`: a failed, timed-out or flaky
bundle holds a failing row; an `xfailed` section an xfailed row), the query
now reads `FINAL` only for the tests that hold such a row in the commit's
jobs, found in one by_job pass (`candidateOutcomes` and `prunedRunsSource` in
`buildRunPageQuery`):

```sql
FROM ci.runs AS run FINAL
PREWHERE run.tests_id IN (
    SELECT run.tests_id FROM ci.runs AS run
    WHERE run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))
        AND run.outcome IN {candidate_outcomes: Array(String)}
    GROUP BY run.tests_id)
```

`tests_id` leads the primary key, so the `FINAL` read keeps 5,266 of 945,976
granules on ce6ff46 (`EXPLAIN indexes = 1`), and the bundles of a candidate
test are complete: `FINAL` resolves replacements within the test's rows,
which the pruning keeps whole. A filter admitting `passed` or `skipped`
bundles, or a sort needing every bundle's final attempt, keeps the grouped
read; the plain by_job read is unchanged.

Measured on ce6ff46 (`outcome=failed`, 10 rows, 2026-10-30, alternating
pairs): grouped read 2.27 to 2.67 s and 413M rows read; pruned read 0.67 to
1.34 s and 181M rows; identical rows. Against the full-`FINAL` baseline, which
reads 7.9 billion rows (506 GB) in 80 to 127 s on 2026-10-30, the pruned read
returns the same rows for `outcome=failed`
(`shared-starts-query-validation.json`, case `commit_outcome_failed`),
`outcome=failed` with `last_attempt_outcome=passed`
(`../test/runs/last-attempt-outcome-query-validation.json`, case
`commit_failed_last_passed`) and the combined attempt filter
(`../test/runs/attempts-query-validation.json`, case
`commit_combined_attempt_filter`). The full-`FINAL` comparisons now exceed the
bundles' former 90-second cap, so those two bundles run live with
`max_execution_time` 300.

Rejected: a scalar holding the candidate (job, test) keys exceeded 15 GB of
memory, the old analyzer copying the nested scalar into every subquery; an
inline `IN` on (job, test) without `PREWHERE` read 552M rows for no gain.

Since 2026-11-05 the `FINAL` read is pruned to the exact starts of the
candidate tests' rows on the commit instead of the tests' every retained row
(see that day's section below).

### Expected failures are not pruned (2026-11-01)

The pruned read costs about one granule per candidate test and part, since a
test's rows sit in every part written while it ran: a set of 80 failing tests
kept 5,266 granules, but the 10,443 tests with an expected failure on ce6ff46
kept 253,925 of 1,082,531, read 2.2 billion rows and took 35.6 to 36.5 s,
where the grouped read of the same page took 2.0 to 2.7 s. So `xfailed` is no longer among the
outcomes a key set is drawn by (`PRUNABLE_OUTCOMES`: the failing outcomes,
`xpassed` and `unknown`); the expected-failures section and an
`outcome=xfailed` filter take the grouped read. The
`commit_status_xfailed` case of
[the shared-start evidence](shared-starts-query-validation.json) records the
pruned SQL as before and the grouped SQL as after, with identical rows. A
commit with thousands of failing tests would cost the pruned read the same
way; nothing decides by the count yet.

## The worst_status filter ranks a test's bundles in one pass (2026-11-01)

The API's `worst_status` filter selects the bundles of the tests whose worst
status over every bundle on the commit, in any job, is one of the given, the
tests the summary's `by_worst_status` counts once each; with `status` set to
the same value it lists the bundles those counts' jobs come from. The commit
page's folded sections sent both while its summary counted tests once; since
the summary moved to run counts later on 2026-11-01 the page sends `status`
alone, and the filter stays in the API.

The test's worst status needs every bundle of the test, not only the bundles
the other filters keep, and the summary's `by_worst_status` counts are over
the whole commit. With the filter, `buildRunPageQuery` therefore groups the
scope's rows into bundles as before but keeps the bundle filters out of the
source and the `HAVING`: the status rule, the attempt filters and the last
attempt's outcome become columns of the grouped rows, the identity filters
move out of the source, and a window over the grouped rows ranks each test's
bundles before the outer `WHERE` selects among them:

```sql
FROM (
    SELECT tests_id, environments_id, env_vars_id, github_workflow_job_id, duration_milliseconds, status,
        ['failed', 'timed_out', 'flaky', 'passed', 'other', 'xfailed', 'skipped'][min(indexOf([...], status)) OVER (PARTITION BY tests_id)] AS worst_status
    FROM (
        SELECT run.tests_id AS tests_id, ..., sum(...) AS duration_milliseconds, multiIf(...) AS status
        FROM <the grouped read> GROUP BY run.tests_id, run.environments_id, run.env_vars_id, run.github_workflow_job_id
    )
) AS run
WHERE run.status IN {status: Array(String)}
    AND run.worst_status IN {worst_status: Array(String)}
```

Measured on ce6ff46 (2026-11-01, 25 rows, longest first, three alternating
pairs each): the passed section with the filter 2.0 to 2.4 s, 159M rows read
and 2.6 to 2.7 GB of memory, against the plain passed section's 2.2 to 2.9 s,
414M rows and 2.0 to 2.3 GB; the expected-failures section 2.1 to 2.4 s and
the skipped section 1.8 to 2.2 s, with one 6.9 s sample under load. The rows
are identical to the filter's direct form, the same page with the qualifying
tests found by a second grouped read inside an `IN`, which took 7.9 to 12.7 s
(`commit_worst_passed`, `commit_worst_xfailed` and `commit_worst_skipped` in
[the shared-start evidence](shared-starts-query-validation.json), before and
after). Rejected first: that `IN` form with the second read pruned by
primary key, which lost the pruning inside the set-building subquery and
read 4.3 billion rows in 70 s for the expected-failures section; and, for
the passed section alone, excluding the tests with a failed, timed-out or
flaky bundle through the pruned read, 6.8 s under the same load.

## The summary's lookups (2026-11-01)

The pull request lookup selects by `base.repo.full_name` as well as by
number, since `default.pull_request` holds every repository's pull requests
under their own numbers. The commit lookup gathers the push runs' branches
as an array (`groupUniqArrayIf`) so the summary names main, else the first
by name, deterministically. The neighbours query gathers its twenty
candidates a side once, into an array scalar, since a named subquery runs
again at every reference, and finds their test jobs through
`materialized_views.workflow_job_by_head_sha` and the job table by id instead
of a scan of the job table for test names: 139 million rows and 0.8 to 1.5 s
before, 4 to 6 million rows and 0.15 to 0.37 s after, 65 to 105 MB of memory
before and 4 to 19 MB after, with the same rows on six commits of main,
nightly and viable/strict, one of them 24 days old
([the summary evidence](summary-query-validation.json), `lookups`). The newer
side prunes the push table by its timestamp key as the key spells it,
`tupleElement(head_commit, 'timestamp')`, which the dotted form does not;
the older side keeps the dotted subcolumn, since the key's spelling reads
the whole `head_commit` tuple, 700 MB over the older rows, for 2.6 million
rows the subcolumn reads in about 100 ms (until 2026-11-03, when it began
reading in key order; see that day's section). On a push run a job's `head_sha`
is its run's (111,248 of 111,248 test jobs of the week before), so the
candidates with a test job are the ones the runs name.

Two more lookups were added on 2026-11-02 for the page's "Newer commit
available" pill, `branch_head` (the newest push to a pull request's head
branch after the commit, for a branch in the repository) and `record_head`
(the time of the commit a pull request record names, since a record misses a
push now and then: #202963's still named 7a43f10 an hour after 31e73b6 was
pushed), and removed the same day with the pill and with
`pull_request.head_sha`; the info query no longer gathers each recorded pull
request's head repository, and the record lookups no longer read `head.sha`.

A fourth lookup since 2026-11-02, `pull_request_by_head`
(`buildCommitPullRequestByHeadQuery`), runs for a commit whose runs record no
pull request and that no push run put on a branch: the pull requests whose
head the commit has been, through `materialized_views.pr_by_sha` (ordered by
`head_sha`), and the repository's record of the lowest numbered of them, with
its head branch. It exists because every run of a pull request from a fork records no pull request at
all: of the workflow runs created in the two days before, the 1,482
`pull_request` runs from forks (333 head commits) had an empty `pull_requests`
array, their ciflow tag push runs too, while the 3,199 from branches in the
repository (440 heads) all recorded theirs, and `pr_by_sha` knew all 333.
Until then a fork head was described as a branch commit with no branch, no
pull request and no neighbours. The lookup reads 16 to 19 thousand rows in
14 to 120 ms on the three lookup cases, `fork_head_c7ee7fb5` among them
(#189727, head branch `xpu_serial_ci` in the fork: its info lookup records no
pull request and this lookup finds the record). A commit with push runs on a
branch is never looked up, so a main commit costs nothing more, and a record
whose number another repository's pull request shares is ruled out by the
base repository.

## Commit summary counts (2026-10-30)

`GET /api/tests/commit/{sha}/summary` counts the commit's tests by status
for the commit page's header row (`lib/api/tests/commit/summary/query.ts`):
per worst result the tests and the distinct jobs of their bundles with that
result, and for the whole commit (the rollup row) the tests, jobs and
bundles of each status and the span of the runs. Membership is the runs
endpoint's; bundles are read as the statistics read them, one-row keys
straight off by_job and the rest through `FINAL` at shared starts, and each
test's bundles are aggregated as one array of (job, status) pairs.

Measured on ce6ff46 (9,177,729 bundles, 2026-10-30): the per-status
`groupUniqArrayIf` form took 7.5 to 7.8 s elapsed; the one-array form 3.1 to
3.6 s, identical rows (7 rows, digest `12e5949c2ee7e03e`), 150M rows and 1.6
GB read, about 105 MB of memory. One thread takes 16.3 s, so the query costs
about 16 CPU-seconds and runs in the heavy workload (`CI_WORKLOAD_HEAVY`);
it left the workload on 2026-11-05, rewritten (see that day's section below).
The full-`FINAL` baseline, every row of the commit's jobs read through `FINAL`
and grouped into bundles, returns the same rows: recorded in
`summary-query-validation.json` (`scripts/validateCommitSummaryQueries.cjs`,
two alternating pairs on 2026-10-31 UTC), the baseline took 112 to 124 s
reading 7.9 billion rows (507 GB) against 3.1 to 3.2 s and 150M rows for the
working query on ce6ff46, and 110 to 112 s against 1.5 s on the pull request
head 06b5f47 (224,867 tests in 108 jobs, none failed), identical complete rows
both times. The bundle was recorded again on 2026-11-03 with the
commit job lookup, the info query's push read by key and the key-ordered
neighbours, in one pair with a 900-second limit, since the baseline now takes
over four minutes (see the 2026-11-03 sections below). The commit's own lookup, its pull request's title and its branch
neighbours, recorded beside them, answer in 0.2 s, 6 ms and 1.3 s. The counts agree with the commit
statistics' bundle counts (5 failed, 8 timed out, 87 flaky bundles) and with
the plan's figures (672,763 tests in 333 jobs; 4, 8 and 68 tests failed,
timed out and flaky; 529,412 passed; 10,270 expected failures; 133,001
skipped in every job).

## Commit page in outcome order (2026-11-01)

The commit page lists its runs as one list in the hub's outcome order,
failed, timed out, flaky, passed, other, expected failures, skipped, and
within each outcome the page's sort, longest first by default. The runs
endpoint gained a `status` sort field for it: the bundle status rule
(`BUNDLE_STATUS_SQL`) as a column of the grouped rows, ranked by its index in
`BUNDLE_STATUSES` (`indexOf`, a UInt8 cursor key), so one request with one
cursor pages across the outcomes. The status filter already read the rule in
`HAVING`; the sort reads it once more as a column, with the chronology and
outcome columns the rule needs, and like the other mutable sorts takes the
deduplicated read.

Measured on ce6ff46 (`commit_status_sort` in
[the shared-starts evidence](shared-starts-query-validation.json), four
alternating pairs): the page's default request, `status=failed,timed_out,
flaky,other` with `sort=status,-duration_milliseconds`, took 0.74 to 1.69 s
reading 192M rows and 32 to 73 MB of memory, with the same index pruning as
the request without the sort (6,452 of 1,087,526 granules through the
80-element test set). The baseline, what the page did until this day, one
page per outcome concatenated in that order, written as one statement (a
UNION ALL of the per-status pages with their own parameters and the same
ORDER BY), returned identical complete rows (100) and took 1.66 to 2.36 s
reading 283M rows and 163 to 172 MB. The request without the status sort,
the problem statuses sorted by duration alone, measured in alternating runs
beside the sorted one: 0.60 to 1.42 s against 0.70 to 1.01 s, the same rows
read, noise. On a test's own page the sort is as cheap as any other (6 rows,
0.05 s).

On 2026-11-02 the rank was turned around: `status` ranks best first, skipped
through failed, so `-status` puts the worst first as the tests list's `status`
sort does, and the page asks for `sort=-status,-duration_milliseconds`. The
case was re-recorded with that request against the same baseline, its
per-status pages ordered as the new sort orders (four alternating pairs,
identical complete rows, 100): the page's request took 0.63 to 0.87 s reading
191M rows and 65 to 83 MB; the baseline 1.38 to 1.73 s after a first cold run
of 7.6 s, reading 280M rows and 168 to 205 MB. The commit list's `stats`
field and its `commit_stats` unchanged entry left the bundle the same day (see
the statistics section above).

## The commit's jobs come from the `head_sha` view (2026-11-03)

Every commit query begins with `matched_job_ids`, the IDs of the jobs of the
commit's workflow runs (`commitRunsScope` in `query.ts`): the runs page and
its probe, and the summary's counts. It found the jobs in `default.workflow_job`
by `run_id IN (...)`, but the job table is ordered by job ID, so the scalar
read every one of its 128 million rows, about a gigabyte, at every request.
The jobs now come from `materialized_views.workflow_job_by_head_sha`, which
is ordered by `head_sha`, `run_id` and `id`: its rows of the commit's SHA
whose run is one of the commit's runs, the runs still matched by their own
`head_sha` and repository through `workflow_run_by_head_sha` as before.

That reads the same jobs because a job's `head_sha` is its run's. The
comment this replaces said a pull request job's SHA could name its merge
commit instead; nothing in the job table does. Of the 3.66 million jobs
created in the 15 days before 2026-11-03, of every event, and of the 26
million created from July to October, none has a `head_sha` that differs
from its run's (latest versions of both). And over every workflow run
version created in the 16 days before 2026-11-03 04:30 UTC (433,682), the
(SHA, job) pairs the old lookup finds and the pairs the view finds are the
same set, 3,761,197 pairs, with nothing in either difference. The view is
fed by a materialized view of every insert into the job table, with no
filter. The comparison query:

```sql
WITH runs AS (
    SELECT DISTINCT id, head_sha FROM default.workflow_run
    WHERE created_at >= now() - INTERVAL 16 DAY
)
SELECT
    (SELECT count() FROM runs) AS run_versions,
    (SELECT count() FROM (SELECT DISTINCT run.head_sha AS sha, job.id AS job
        FROM default.workflow_job AS job INNER JOIN runs AS run ON run.id = job.run_id)) AS job_table_pairs,
    (SELECT count() FROM (SELECT DISTINCT run.head_sha AS sha, head_sha_job.id AS job
        FROM materialized_views.workflow_job_by_head_sha AS head_sha_job
        INNER JOIN runs AS run ON run.id = head_sha_job.run_id AND run.head_sha = head_sha_job.head_sha)) AS view_pairs,
    (SELECT count() FROM (
        SELECT DISTINCT run.head_sha AS sha, job.id AS job
        FROM default.workflow_job AS job INNER JOIN runs AS run ON run.id = job.run_id
        EXCEPT
        SELECT DISTINCT run.head_sha AS sha, head_sha_job.id AS job
        FROM materialized_views.workflow_job_by_head_sha AS head_sha_job
        INNER JOIN runs AS run ON run.id = head_sha_job.run_id AND run.head_sha = head_sha_job.head_sha
    )) AS only_in_job_table,
    (SELECT count() FROM (
        SELECT DISTINCT run.head_sha AS sha, head_sha_job.id AS job
        FROM materialized_views.workflow_job_by_head_sha AS head_sha_job
        INNER JOIN runs AS run ON run.id = head_sha_job.run_id AND run.head_sha = head_sha_job.head_sha
        EXCEPT
        SELECT DISTINCT run.head_sha AS sha, job.id AS job
        FROM default.workflow_job AS job INNER JOIN runs AS run ON run.id = job.run_id
    )) AS only_in_view
```

Measured on ce6ff46 and 06b5f47, the lookup alone fell from 128 million rows
and 1 GB read, 0.13 to 0.44 s, to some 70 thousand rows and 2 MB, 0.015 to
0.02 s, with the same job IDs. Alternating runs of whole statements the same
day, at the default thread count, returned identical rows: ce6ff46's default
page 1.2 to 8.9 s (median 5.0) before against 1.1 to 1.2 s after, its page
without filters 0.9 to 1.6 against 0.5 to 0.8 s, 06b5f47's default page 0.39
to 0.48 against 0.10 to 0.25 s; and at the heavy workload's four threads the
summary counts 6.8 to 9.2 against 6.3 to 6.4 s on ce6ff46 and 2.0 to 2.5
against 1.6 to 1.7 s on 06b5f47. Every commit case of the evidence was
regenerated with the new scope and replayed live with identical complete
rows. The
[attempt bundle](../test/runs/attempts-query-validation.json) and
[last-attempt outcome](../test/runs/last-attempt-outcome-query-validation.json)
commit cases ran against their full `FINAL` baselines, which now read about 10
billion rows in two to four minutes per execution; each regenerated case says
so in its `regenerated` field. The 13
[shared-starts](shared-starts-query-validation.json) cases ran against the
queries they replace, the working queries with the old job lookup, since
their full baselines no longer finish in the replay's limit (see that
section above): they read 149 to 428 million rows before and 21 to 73
million after, the difference being the old lookup's 128-million-row scan,
which ran once in some statements and three times in the others. The
[summary](summary-query-validation.json) counts ran against their full
baseline in one pair, which now takes 250 to 256 s and reads 10.6 billion
rows, 690 GB, per execution, against 6.6 and 1.7 s for the counts: identical
complete rows, the same as the old counts query and the baseline returned on
2026-10-31 (equal digests). Its lookups were recorded again with the new info
and neighbours queries; eleven of the twelve returned what they returned on
2026-10-31, and the twelfth, the fork head's info, a workflow run more, which
the old info query returns too.

## Both neighbour sides read in key order (2026-11-03)

Until 2026-11-03 the neighbours query's older side read the push table by
the dotted subcolumn, `head_commit.timestamp`, which the table's sort key does
not match, so it read the timestamp of every push, 2.6 million rows, to keep
the twenty newest older ones. It now spells the key as the newer side does,
`tupleElement(head_commit, 'timestamp')`, in its `WHERE` and its
`ORDER BY ... DESC`, so the read runs in reverse key order (`ReadType:
InReverseOrder`) and stops at the branch's twentieth older push: about 140
thousand rows on main. The concern recorded above, that the key's spelling
reads the whole `head_commit` tuple, did not reproduce for this read: on a
branch with two pushes, where it still reads every older push, it read 3.39
million rows and 109 MB against the old 108 MB, with 2 MB of memory.

Compared with the old query on seven fixtures, four alternating rounds each,
every execution returned the same rows. Medians, old against new: main at
ce6ff46's time 0.50 against 0.33 s, two days earlier 0.53 against 0.39 s, 24
days earlier 0.68 against 0.49 s, at the newest pushes 0.49 against 0.30 s;
viable/strict 0.56 against 0.42 s; nightly, whose commits have no test job,
0.56 against 0.52 s; and the two-push branch 0.25 against 0.24 s. The
candidates' job lookups are unchanged.

## The commit's pushes are read by key (2026-11-03)

Until 2026-11-03 the info query found the commit's pushes by a scan of the
push table's head commit ids, 2.6 million rows and 130 MB, since the table is
ordered by commit timestamp, then id. It now finds the timestamp through
`materialized_views.push_by_sha`, ordered by commit id and fed by a
materialized view of every push insert, and reads the push table by its
timestamp key and the id: some 50 thousand rows and 8 to 19 MB. The view
holds every push: of the 1,876,574 push rows with a head commit on
2026-11-03, none lacked its (id, timestamp) pair there, and both timestamps
are `DateTime64(9)`. The curated `pr_commits` and `recent_pr_workflows_query`
queries read pushes the same way.

Compared with the old query on eight commits, a main commit, a pull request
head, a fork head, viable/strict and nightly commits, a main commit 2,000
pushes back and an unknown SHA, four alternating rounds each, the query took
0.19 to 0.24 s before and 0.020 to 0.054 s after (medians). Every row was the
same once `refs`, a `groupUniqArray`, is sorted. For the pull request head the
two reads returned its three refs in a different order. `groupUniqArray`
defines no order, and the summary sorts the branches it takes from the refs.
The other seven rows were identical as returned.

## Index analysis, counts by rank and exact starts (2026-11-05)

On 2026-11-05 the commit page's header, which waits for the summary, took 9
to 18 seconds on ce6ff46 through the dev server, longer than the table below
it, whose first page took 8 to 51 seconds; a week before, the evidence had
both within a few seconds. The runs table had grown to about 1.9 million
granules in 220 to 730 parts, and three changes followed, each compared live
with the statement it replaces on fixed commits, with identical rows.

**Index analysis.** Before it reads `ci.runs` without `FINAL`, ClickHouse
analyses the read against the main table and the by_job projection and takes
the one with fewer marks. A condition the main table's primary key can use
makes that analysis search the main table's index in every part, even when
by_job, pruned by the commit's jobs, is the read that wins: a set of (job,
test) keys naming thousands of tests, or a `NOT IN` on (test, start), which
prunes nothing. Counting the rows of ce6ff46's 4,993 multi-row (job, test)
keys, which name 3,763 tests, took 1.87 to 2.08 s with the test visible to
the index and 0.85 to 0.93 s with `identity(run.tests_id)` (three alternating
pairs, 4 threads), reading the same 11.0 million rows and returning the same
count. `identity()` is ClickHouse's documented way to keep an expression out
of index analysis; by_job still prunes by the key's job. The counts query
held the key set in four reads and the shared starts' `NOT IN` in a fifth,
and the page's grouped (shared-start) read holds the same `NOT IN`; the
test, and the `NOT IN`'s start, now go through `identity()`. The `FINAL`
read's `PREWHERE` at the shared starts keeps its key columns, since it is
the read that must prune. Hiding the start as well as the test took the
counts' multi-row branch from 1.78 to 1.06 s (best of four, 4 threads).

**Counts by rank.** The counts query carried each test's bundles as an array
of (job, status word) pairs, which each test's row then read some 25 times
with string comparisons (`WORST_RESULT_SQL`, `CATEGORY_JOBS_SQL` and three
array functions per status). It now gathers each test's bundles into two
parallel arrays, jobs and UInt8 ranks (a status's place in
`BUNDLE_STATUSES`, failed 1 to skipped 7), beside the test's least rank and
the ranks it holds as bits, unfolds them with `ARRAY JOIN` into one row a
bundle, its test's first bundle marked, and counts with `countIf` and
`uniqExactIf` in one aggregation, returning the same rows. On ce6ff46 at one
thread (best of two each): the query as of 16fdbd5de 22.7 s, with
`identity()` alone 6.4 s, with ranks as well 4.7 s, all three with identical
rows. Two other forms of the aggregation, grouping by the numeric worst rank
and array functions over the test's rows without `ARRAY JOIN`, returned the
same rows and were no faster (best of three at one thread: 4.47 and 4.50 s
against 3.97 and 4.11 s for the chosen form in the same runs).

**Exact starts for rare outcomes.** A page whose filters admit only bundles
holding a rare outcome (the default commit page: failed, timed out, flaky and
other) read `FINAL` pruned to the candidate tests, `PREWHERE run.tests_id IN
(...)`, which reads each such test's every retained row, in every part and
every day of retention: 9,087 of 1,876,804 granules in 223 of 232 parts for
ce6ff46's 80 candidate tests (`EXPLAIN indexes = 1` in the evidence's
`commit_status_sort` case), 6,452 granules on
2026-11-01, growing with the table. It now prunes `FINAL` to the exact
(test, environment, env var set, start) of the candidate tests' rows on the
commit, found by a second by_job pass, as the attempts read prunes since
2026-11-03 (`prunedRunsSource` in `lib/api/tests/test/runs/query.ts`):

```sql
FROM ci.runs AS run FINAL
PREWHERE (run.tests_id, run.environments_id, run.env_vars_id, run.started_at) IN (
    SELECT run.tests_id, run.environments_id, run.env_vars_id, run.started_at
    FROM ci.runs AS run
    WHERE run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))
        AND identity(run.tests_id) IN (SELECT run.tests_id
            FROM ci.runs AS run
            WHERE run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))
                AND run.outcome IN {candidate_outcomes: Array(String)}))
WHERE run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))
```

The 1,147 starts on ce6ff46 keep 2 of 234 parts by their days and 178 of
194,419 granules in them. Every stored version of a row shares its key, so
`FINAL` still resolves each row's replacements, and every bundle of a
candidate test on the commit is read whole, a superset of the bundles the
filters select, as before. The second pass holds the tests through
`identity()`, so it reads by_job by the commit's jobs alone: on ce6ff46 the
two passes read 20.0 million rows, every row of the commit, in 0.22 s.
Spelled plainly, ClickHouse served the second pass from the main table by the
80 tests instead, 12.2 million rows in 0.31 s, a read that grows with each
candidate test's retained history, the cost the old pruning paid, where
by_job's grows only with the commit; whole page queries took the same time
either way (four alternating pairs, 14.1 against 21.9 million rows read,
measured in the review of 2026-11-05).

The evidence replays every changed statement against the one it replaces, as
recorded until this day (the working queries as of 16fdbd5de, which earlier
recordings had shown equal to the full-`FINAL` baselines; those baselines
read some 10.6 billion rows in two to four minutes per execution and were
not run again), in alternating pairs with identical complete rows:

| Case (evidence)                                                                                                                               | Before         | After          | Rows read before / after |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------- | ------------------------ |
| Summary counts, ce6ff46 ([summary](summary-query-validation.json), 3 pairs)                                                                   | 6.5 to 14.0 s  | 1.5 to 5.2 s   | 23.0M / 23.0M            |
| Summary counts, 97a3cf6 (1,006 jobs)                                                                                                          | 4.5 to 5.4 s   | 2.0 to 2.7 s   | 21.9M / 21.9M            |
| Summary counts, 06b5f47 (pull request head)                                                                                                   | 1.4 to 1.9 s   | 0.85 to 1.1 s  | 4.9M / 4.9M              |
| Default page, ce6ff46 (`commit_status_sort`, [shared starts](shared-starts-query-validation.json), 4 pairs)                                   | 2.0 to 17.7 s  | 0.39 to 0.63 s | 84.0M / 21.9M            |
| `outcome=failed`, 97a3cf6 (`commit_outcome_failed`)                                                                                           | 0.43 to 0.96 s | 0.18 to 0.34 s | 22.5M / 19.5M            |
| `outcome=failed` + `last_attempt_outcome=passed`, 9cc78e09 ([last attempt](../test/runs/last-attempt-outcome-query-validation.json), 3 pairs) | 2.6 to 11.9 s  | 0.43 to 0.77 s | 9.4M / 1.6M              |
| Combined attempt filter, 9cc78e09 ([attempts](../test/runs/attempts-query-validation.json), 3 pairs)                                          | 0.29 to 6.9 s  | 0.11 to 0.13 s | 9.3M / 1.6M              |

No summary case sends rows through the counts query's `FINAL` read: it looks
for shared starts only inside the multi-row (job, test) keys, and every
recorded plan shows that set empty; 97a3cf6's 28 shared starts lie across
jobs, in one-row keys read straight off by_job. That branch's changed `NOT
IN` is covered live by the page cases, whose grouped read takes those 28
starts through `FINAL`, and was checked in the review of 2026-11-05 on
synthetic rows with duplicate versions inside one key, in local ClickHouse
(25.8 with both analyzers and 26.9; the scripts are not kept here), where the
old counts query, its full-`FINAL` baseline and the new query returned the
same rows.

The eleven other shared-start cases take the grouped read, whose only change
is the `NOT IN`: the same rows read, most a little faster (`-ended_at` 2.4
to 3.2 s before and 1.4 to 2.2 s after, `status=xfailed` 4.5 to 8.8 and 2.9
to 4.7 s) and the `worst_status` cases within the noise of a busy afternoon.

Through the dev server, the working tree against a copy of 16fdbd5de on a
second port, three alternating pairs of each request with identical
responses: ce6ff46's summary 8.0 to 12.1 s before and 1.5 to 3.4 s after and
its default first page 3.0 to 27.7 s and 2.4 to 3.3 s; 5837d68's (main,
2026-11-04) summary 7.6 to 7.8 and 2.1 to 3.6 s and first page 4.6 to 11.7
and 2.5 to 2.7 s; 06b5f47's summary 2.2 to 3.2 and 1.3 to 1.7 s, and its
first page 0.34 to 0.41 and 0.41 to 0.54 s, a page with no failing test
whose query reads the same 2.4 million rows in about 0.1 s either way.

Expected failures stay out of the pruned read (`PRUNABLE_OUTCOMES`): pruned
to their rows' exact starts, ce6ff46's 10,443 tests with an expected failure
still cost 202 million rows and 15 to 50 s against 31 million and 7 to 13 s
for the grouped read (three pairs, identical rows).

The counts query left the heavy workload (`CI_WORKLOAD_HEAVY`) with this
change: it costs about five seconds of one thread on a main commit, under
the ten CPU-seconds the API README's "Heavy queries" sets, and queued behind
tests pages it held up the commit page's header.

Not changed: the neighbours query's 40 push candidates read the whole
`head_commit` tuple, 275 MB, because the push table's key is
`tupleElement(head_commit, 'timestamp')`; an explicit `PREWHERE` on the ref
and repository read the same bytes and was no faster (0.47 to 0.62 s against
0.44 to 0.58 s, identical rows). It runs beside the counts, so the summary
waits for whichever ends last.

## The commit's jobs and their tests (2026-11-15)

`GET /api/tests/commit/{sha}/jobs` reads the commit's jobs
(`buildCommitJobsQuery`) and, per job, what its retained runs did
(`buildJobTestsQuery`); `GET /api/tests/job/{job_id}` reads one job's test
files (`buildJobFilesQuery`); and the `job_id` filter narrows the commit's
runs. Measured with the working tree's SQL on pytorch/pytorch main
`242a9cf0e013551eaada7827cfff1aa8d293dfb1`: 851 jobs, 341 with retained runs,
4,895,051 bundles.

- Jobs: 851 rows in 0.03 s, 0.10 million rows read; `workflow_job` reads 3 of
  33,307 granules and `workflow_run` 4 of 15,393.
- Tests per job: 341 rows, 12.92 million rows and 331 MB read, about 100 MB
  of memory, 636 of about 1,822,233 `by_job` granules for the keys holding
  one row. 2.4 to 3.3 s at the default threads, a median of 3.5 s over six
  rounds at 2 threads, 4.05 to 4.7 s at 1; the counts alone take 0.98 s at 2
  threads. The rows equal, byte for byte, those of a reference that sends
  every row through `classifiedRunsSource` before grouping (16.08 million
  rows, 589 MB), and their sums by status equal the summary's counts.
- Rewrites measured in alternating rounds at 1 and 2 threads and not kept,
  none beating the noise between runs: bitmaps for the slots (their rows
  differed from run to run), pairs expanded after grouping, and two partial
  aggregates per job merged (about 10% at best).
- One job's files (job 132470962156, 44 files in 232 reports): 232 rows in
  0.13 to 0.18 s, 6 `by_job` granules; the files' sums equal the job's
  counts.
- The runs page with `job_id`: 6 `by_job` granules, 0.15 s for the job alone
  (0.43 million rows) and 1.3 to 1.45 s with a `file` filter (4.99 million
  rows, the tests catalog read that filter already made). Without `job_id`
  the SQL is unchanged.
- A recorded attempt covers each 5-second step it ran in; 5.1% of the
  commit's executed attempts cross a step's boundary.

## Filters ahead of the grouping (2026-11-16)

A commit page's catalog filters (`file`, `search`, an environment's fields,
`test_config`) are conditions on a group key, which ClickHouse pushes into
the run reads. With the run's ID bare it then searched the main table's
primary index for the catalog's IDs in every part before it chose `by_job`,
and built the catalog's set once for each read. Three changes
(`selectionJoins` in `lib/api/tests/test/runs/query.ts`):

- A `by_job` scope's catalog filters hold the run's ID through `identity()`.
  The main table's index is left out; `by_job`'s own still prunes by the ID
  (`EXPLAIN indexes = 1`: 2 granules for one test of a job, with and without).
- A test filter alone reads the catalog whole. Bounded by the scope's tests,
  it read every run of the commit to bound a table of 0.9 million rows; a
  sort by a test field still joins the catalog bounded so.
- A `workflow_path` filter alone names the workflows' jobs in an `IN`, which
  applies ahead of the grouping; joined, the paths met every job's bundles
  after it. The lookup is bounded by the scope's own jobs (`jobIds`), not by a
  read of the scope's runs. A test's page keeps the join: its lookup starts
  from a read of the test's runs, and as an `IN` its page query took 1.1 to
  1.6 s against 0.8 to 1.3 s.

The page query alone on pytorch/pytorch `242a9cf` (851 jobs), server seconds
on one kept connection in alternating rounds, the same rows every time:

| Page                                                |      Before |       After | Rows read, before → after |
| --------------------------------------------------- | ----------: | ----------: | ------------------------: |
| A job's file (`job_id`, `file`), 101 rows           | 1.115–1.223 | 0.238–0.390 |           5.25 M → 5.09 M |
| The same, 13 rows (`limit=12`, no status)           | 1.198–1.379 | 0.236–0.527 |           5.25 M → 5.09 M |
| A job's test (`file`, `suite`, `case_name`), 1 row  | 0.349–0.578 | 0.326–0.703 |           5.23 M → 5.06 M |
| The commit's `file`, 101 rows                       | 2.586–3.182 | 0.423–0.871 |         41.53 M → 20.95 M |
| The commit's `search`, 101 rows                     | 1.252–2.784 | 0.674–1.139 |         36.69 M → 20.95 M |
| Failing statuses and `search`, 46 rows              | 0.479–0.668 | 0.258–0.366 |         25.26 M → 14.97 M |
| `accelerator` and `python_version`, 101 rows        | 1.706–2.297 | 0.470–0.726 |         16.15 M → 16.15 M |
| `test_config`, 101 rows                             | 1.425–1.872 | 0.670–1.001 |         16.15 M → 16.15 M |
| `workflow_path` (81 jobs of the commit's), 101 rows | 0.820–3.139 | 0.486–0.946 |         26.60 M → 12.09 M |

The handlers of HEAD and of the working tree, called in alternation four
times a side, answered 22 requests with the same bytes apart from the timing
fields: the page's own and every drill-in request, the pages above, sorts by
`job_name` and `workflow_path`, `worst_status`, a second page, and a test's
runs. Medians of the whole request, HEAD to working tree, with the attempts
read's change of the same day, the three lookups after the page at once and
one kept client: the default page 1.9 to 0.9 s, a workflow 2.6 to 1.3 s, a
build 2.3 to 1.1 s, a job 1.9 to 0.8 s, a job's file 2.8 to 1.0 s, the
commit's `file` 5.0 to 1.5 s. Each of those requests opened its own
connection, which often meets a replica that has not read the commit: there
the `search` page's query took 1.4 s before and after. A sort by `job_name`
with a `workflow_path` filter keeps its join, which reads 16.2 million rows
where it read 26.6 million, in the same time within the noise (0.77 to 1.33 s
against 0.78 to 1.62 s). `commit_rich` was recorded again on `242a9cf`, its
own commit being past the retention: 11 rows equal in 8 runs, 2.03 to 2.27 s
before and 0.69 to 1.22 s after.

Measured and not kept: the catalog's IDs in a WITH scalar (nested in the
scope's, it ran past 120 s); `enable_optimize_predicate_expression = 0` (as
fast for a job's page, but a commit is then grouped whole before the filter);
the workflow's jobs in every read (4.9 to 5.4 s, the lookup's CTE copied into
six subqueries) or in the scope's scalar (1.9 to 2.7 s); and
`optimize_aggregation_in_order` for the jobs' tests, which read the main
table in key order, 14.8 billion rows in 45 s.

## The stretches come from the gaps between slots (2026-11-16)

`buildJobTestsQuery` folded each job's slots into stretches with two lambdas
that looked a slot's neighbour up in the array (`covered[position - 1]`,
`covered[position + 1]`, `length(covered)`). A lambda that names an array from
outside has that array copied for every element it runs on, so each job's
slots were copied once a slot: 4.0 GB of memory on `242a9cf`, where the rest
of the query takes 0.6 GB, and most of its time. The 100 MB noted on
2026-11-15 was read before the query's end; `wait_end_of_query = 1` gives the
figure. The stretches now come from `arrayDifference(covered)`, the gap
between a slot and the one before it and 0 for the first: a stretch begins
where the gap is not 1, and ends where the next slot's is not.

Alternating rounds on one kept connection at the default threads, the same
rows in every run:

| Scope                          | Jobs with tests | Before, server seconds |     After | Memory, before → after |
| ------------------------------ | --------------: | ---------------------: | --------: | ---------------------: |
| main `242a9cf` (8 rounds)      |             341 |              1.47–4.21 | 0.45–1.31 |        4.0 GB → 0.6 GB |
| main `b02f82e` (5 rounds)      |             241 |              1.19–3.30 | 0.45–0.64 |        3.6 GB → 0.5 GB |
| A pull request's `37f3195` (5) |             191 |              0.32–0.59 | 0.30–0.51 |        0.4 GB → 0.4 GB |
| One job, `132467067582` (5)    |               1 |              0.36–0.45 | 0.36–0.50 |                      — |

The handlers of the tree before the change and of the working tree answered
the request with the same bytes apart from the timing fields for those three
commits and for main `8494b15` and the pull requests' `c7603ef`, `62fe275` and
`f0b3dae`, the last two with no retained runs. `EXPLAIN indexes = 1` and
`EXPLAIN ESTIMATE` are the same before and after: 636 and 98 `by_job`
granules, 6.01 million rows in 4 parts.

## A job's run attempt (2026-11-17)

The jobs' SQL (`jobsSql`, read by `buildCommitJobsQuery` and `buildJobQuery`)
also selects `workflow_job.run_attempt`, for the page's row per run and
attempt. Measured with the working tree's SQL on pytorch/pytorch
`e85246f25360bf865d37e005f39e5b87eeb597d2`, 429 jobs, 155 of a first attempt
and 274 of a second, and on its job 133666382925, in seven alternating
rounds, seconds from the request to the whole answer:

| Query                          |      Median |       Range | Read             |
| ------------------------------ | ----------: | ----------: | ---------------- |
| Commit's jobs, before          |       0.715 | 0.711–0.731 | 0.112 M, 78.3 MB |
| Commit's jobs, with the column | 0.725–0.751 | 0.717–0.832 | 0.112 M, 78.7 MB |
| The same with `PREWHERE`       |       0.757 | 0.717–0.876 | 0.112 M, 78.7 MB |
| The same without `FINAL`       |       0.721 | 0.713–0.782 | 0.113 M, 78.8 MB |
| One job, before                |       0.251 | 0.240–0.304 | 0.013 M, 9.1 MB  |
| One job, with the column       |       0.246 | 0.241–0.249 | 0.013 M, 9.2 MB  |

The column costs 0.4 MB of reading and nothing that shows above the noise
between runs: the two medians are of two sets of rounds. Neither rewrite
beats that noise, so neither is kept; both returned the same rows. With the
column left out the rows equal those of the query before, for the commit and
for the job. `EXPLAIN indexes = 1` prints the same plan before and after:
the commit's 429 job IDs select 9 of 33,386 `workflow_job` granules in 1 of
15 parts, the one job 1.

## The neighbours ask the nearest pushes first (2026-11-17)

The summary's neighbour lookup was one query: twenty pushes a side from the
push table, and of those the nearest with a test job. On main `242a9cf` it
read 4.40 million rows and 417 MB in 0.33 to 0.48 s, and beside a page's
other queries 0.3 to 4.0 s. Two parts of it cost the most:

- The older side's read. Without a lower bound it read 0.88 million pushes,
  166 to 180 MB and 0.7 GB of memory to find twenty (`Parts: 8/11`,
  `Granules: 3876/3900`), 0.21 to 0.24 s by itself. Bounded to the week
  before the commit it reads 10 thousand rows and 33 MB (`Parts: 4/12`,
  `Granules: 48/3900`) in 0.03 to 0.04 s and returns the same twenty rows.
- The candidates' jobs: 129,264 jobs of the forty candidates, read by ID for
  their names.

Nearly every push of main has a test job: 339 of the 341 pushes of the week
before `242a9cf`, and 357 of the 358 of the week before that. So the
nearest pushes are asked first (`near` in `buildCommitNeighboursQuery`): two
a side, the older ones among the pushes of the week before the commit. The
query answers a row per side, its candidates and the nearest of them with a
test job. The nearest are the first of the twenty, and whether a candidate
has a test job does not depend on the others, so a side they name a
neighbour on has the answer of the full search. A side they leave open is
searched in full, twenty a side as before (`findNeighbours`): one where none
of them has a test job and pushes may lie past them, which on the newer side
means it had both candidates and on the older side, whose nearest stop a
week back, always.

With the older side bounded, on `242a9cf`, the same two rows every time:

| Candidates a side         | Server seconds | Read               |
| ------------------------- | -------------: | ------------------ |
| 20, unbounded (before)    |      0.33–0.48 | 4.40 M, 417 MB     |
| 20                        |      0.29–0.37 | 3.53 M, 272 MB     |
| 3                         |      0.16–0.19 | 0.57 M, 71 MB      |
| 2                         |      0.13–0.15 | 0.40 M, 45 MB      |
| 1                         |      0.12–0.15 | 0.19 M, 25 MB      |
| 2, a row per side (built) |      0.12–0.13 | 0.21 M, 35 MB      |
| 20, a row per side, far   |      0.30–0.41 | 2.65 M, 310–333 MB |

The last two are the working tree's queries. Their final read of
`workflow_run` is by a 51-element set of IDs, 8 of 15,441 granules, where the
full search's is by 543 IDs and 43 granules.

`findNeighbours` against the single query, on 74 commits read in two
alternating rounds each: main's newest three, every fortieth push of its
last 30 days (34), the three pushes of its last 14 days without a test job
with those beside them (11), and of nightly, viable/strict, release/2.15 and
release/2.14 the newest, the oldest and some between (26). The neighbours
are the same on all 74. Nine needed the full search: two of main's, beside
two pushes in a row without a test job, where it names the same neighbour
past them; nightly's five, a branch whose pushes have no test job; and the
first commit of each release branch, which has no older push.

|                          | Before |  After |
| ------------------------ | -----: | -----: |
| Server ms, median        |    433 |    179 |
| Server ms, mean          |    476 |    249 |
| Rows read a search, mean | 4.65 M | 0.60 M |
| Bytes read a search      | 448 MB | 123 MB |

The full search by itself, both sides, against the single query on the same
74: the same neighbours, 508 ms to 415 ms at the median and 4.67 to 2.98
million rows. The three lookup sets of the evidence bundle answer the same
neighbours too; the bundle records both queries
(`validateCommitSummaryQueries.cjs --live --lookups`, which keeps the counts
cases as recorded, their runs having left retention).

Measured and not kept:

- Forms of the older side's unbounded read that might spare the
  `head_commit` tuple: `optimize_functions_to_subcolumns = 1`, the key
  inside `indexHint` with the dotted column as the filter, and `PREWHERE`
  each read the same 0.88 million rows and 174 to 180 MB; ordering by the
  dotted column read every push, 6.6 GB.
- An upper bound on the newer side. It changes nothing for a commit 3 days
  old (0.015 s either way) or 10 (0.10 to 0.20 s either way) and takes one
  18 days old from 0.22 to 0.03 s. It would need the older side's rule, a
  full search whenever the nearest name no neighbour, which the newest
  commit of a branch would then always pay.

## A test filter's IDs are read without FINAL (2026-11-17)

A commit page that filters by test, as the page's request for one file of a
job does, matches the runs' test IDs against the tests catalog
(`selectionJoins`). The catalog read was `FINAL` whether it was joined for a
sort or only gave the IDs of a filter. A filter's IDs do not need it: a test
ID is the hash of the repository, file, suite, case name, declared case name
and language, the only columns a test filter and the search read, and the
owners a filter reads are joined by repository and file. A test's rows
before a merge therefore all pass or all fail, and `IN` drops the repeats.
The catalog held 1,212,632 rows and as many IDs when measured, so the two
reads returned the same rows then too. A sort still joins the catalog
through `FINAL`, since a join needs one row a test.

The page query of job 132467067582's file
`test/inductor/test_torchinductor_opinfo.py` on `242a9cf`, in six
alternating rounds, twice; the catalog is read whole either way (154 of 154
granules in 7 parts), and the rows are the same in every run:

|                | Server seconds, sorted        | Read          |
| -------------- | ----------------------------- | ------------- |
| `FINAL`        | 0.73–3.02, median 1.09        | 6.56 M        |
| Without        | 0.37–2.03, median 0.49        | 5.19 M        |
| `FINAL`, later | 1.55 2.26 2.35 3.73 4.79 6.46 | 6.95 M, 82 MB |
| Without, later | 0.42 1.07 1.41 1.75 2.88 2.91 | 5.18 M, 66 MB |

The whole request, four alternating rounds: 6.7, 4.6, 2.1 and 2.8 s before
and 1.5, 4.0, 2.0 and 1.6 s after. Reading the catalog of a job's files
(`buildJobFilesQuery`) grouped by ID instead of through `FINAL` made that
read two to three times cheaper alone and the query no faster than the
noise between runs, so it is as it was. A date bound on one job's read made
it slower, 0.14 to 0.25 s against 0.014 to 0.046 s: it sets off the main
table's index analysis.

## The summary answers the fields asked for (2026-11-17)

`GET /api/tests/commit/{sha}/summary` takes `fields`, the fields to answer,
and reads only what they need (`getCommitSummary`): the commit's own lookup
always; the pull request's record and the neighbours for `commit`; the
counts query for `counts`, `first_started_at` and `last_ended_at`. The
commit page's header asks for `commit` and `retention_starts_at`, and its
title adds up the jobs endpoint's counts by job, which are the same figures:
on `242a9cf`, 24 failed, 63 flaky, 4,505,785 passed, 73,060 expected
failures and 316,119 skipped either way.

One page load, the summary, the jobs, the first page of runs and the options
asked for at once from one process, six rounds of each tree in turn,
milliseconds as median (range):

|                 | HEAD `31ca40d0b` | Working tree, every field | Working tree, the header's fields |
| --------------- | ---------------- | ------------------------- | --------------------------------- |
| Summary         | 1492 (1363–2489) | 1254 (968–3138)           | 330 (319–848)                     |
| Jobs            | 1724 (1413–3559) | 1230 (1095–2763)          | 1248 (1191–1689)                  |
| Runs            | 1373 (801–1876)  | 1038 (962–1563)           | 931 (834–1259)                    |
| Options         | 470 (349–1318)   | 82 (76–217)               | 80 (77–172)                       |
| Queries, summed | 4695 (3809–9843) | 3309 (2832–6552)          | 1984 (1712–3228)                  |

The header's fields were measured with the counts query taken out of the
working tree's summary, before the parameter was built. The options' gain is
the workflow paths' read, 29 million rows of `health`, answered from the
server's query cache for five minutes (`WORKFLOW_PATHS_KEPT_SECONDS`): a hit
takes 1 to 7 ms and reads no row.

## The pruned read's passes hold the page's jobs (2026-11-17)

A page of rare outcomes reads `FINAL` pruned to the tests holding such a row
(`prunedRunsSource`): one pass over the commit's rows finds those tests and a
second the starts of their rows. Both passes read by the scope's jobs, the
whole commit, whatever the page's own filters: with one job picked and its
problem outcomes listed, as a click on "failed" in the commit page's title
asks, the query read the commit's 12.59 million rows for one job's tests.
The passes now hold the page's `job_id` filter too. Every row
of a bundle is its job's, so the passes find the same tests and starts for
the bundles the page can list; a `worst_status` page keeps the scope's
filter alone, since it ranks a test's bundles in every job.

The page query on `242a9cf`, six alternating rounds each, the same rows in
every run and the same response from the handlers before and after:

| Page                               | Rows | Before, server s | After     | Read, before → after |
| ---------------------------------- | ---: | ---------------: | --------- | -------------------- |
| Job 132452857243, problem outcomes |    8 |        0.53–1.00 | 0.17–0.30 | 12.59 M → 0.46 M     |
| A build's six jobs, the same       |   13 |        0.28–0.49 | 0.11–0.15 | 12.59 M → 1.08 M     |

`EXPLAIN indexes = 1` of one pass: `by_job`, 636 granules in 2 parts by the
commit's jobs, and 17 in 1 part with the job. The default page and a
`worst_status` page with a job generate the SQL they did.

An `environments_id` filter is left out of the passes. With it, the page
query took 1.36 to 2.68 s against 0.30 to 1.10 s before, and one pass alone
0.62 to 0.95 s against 0.09 s, reading the same 5.28 million rows through
`by_job` either way.

## The jobs and their tests are fields of the answer (2026-11-17)

`GET /api/tests/commit/{sha}/jobs` answers `jobs`, `tests` or both
(`fields`), each from its own read, made only when its field is asked for.
The two queries are those of the 2026-11-15 section and their SQL is
untouched: `jobs/query.ts` and `query.ts` are the files they were. The commit
page asks for the two fields in a request each, at once, and draws the jobs
while their tests are read.

The reads differ: on the commits measured the jobs read 0.08 to 0.14 million
rows in 53 to 100 ms of server time, and their tests millions, 12.9 million on
`242a9cf` (851 jobs), in 0.5 to 7.6 s. Requests for that commit from a page of
each production build, twelve rounds in turn, milliseconds as median (range);
the database time is the answer's `query_duration_ms`, the two reads' times
added where one answer carries both. The answers are 582 KB and 347 KB where
the one was 929 KB.

| Request                       | Answer           | Database time    |
| ----------------------------- | ---------------- | ---------------- |
| HEAD `56968c6e3`, both reads  | 1612 (1196–2952) | 2363 (1661–4597) |
| `fields=jobs`                 | 573 (563–833)    | 535 (529–799)    |
| `fields=tests`, sent with it  | 1335 (1157–2367) | 1322 (1142–2352) |
| No `fields`, the working tree | 1534 (1128–6589) | 2015 (1629–7083) |

Ten loads of the commit page from each build in turn, in a quiet minute: the
timeline's rows after 1171 ms (1089–1924) where the whole timeline had come
after 2535 ms (1788–2921), and its colors and the title's counts after 2200 ms
(1683–2899). In a busy minute the tests read took 1.3 to 9.8 s, and the colors
of the one build and the whole timeline of the other waited for it alike.

## Failing attempts are counted (2026-11-17)

`buildJobTestsQuery` answered the 5-second slots in which an attempt failed,
one entry a slot, and the page said their number as the job's failing
attempts, so attempts that failed in one slot counted once: on pytorch/pytorch
`8191b6d`, job 134425602143, with 55 failed tests, said 18 failing attempts
where its files' reports hold 174. Nothing reads when an attempt failed, so
both queries now answer counts (`failed_attempts`, `flaky_attempts`), and
`buildJobFilesQuery` counts where it listed the times.

The baseline is the query before with that change alone, its outer aggregates
summing the lengths of the lists the inner selects made; in the query kept
the inner selects count. Six alternating rounds each on one kept connection,
server seconds; the baseline and the query kept returned the same rows in
every round:

| Scope                    | Jobs with tests |    Before |  Baseline |      Kept |
| ------------------------ | --------------: | --------: | --------: | --------: |
| main `242a9cf`           |             341 | 1.11–5.13 | 1.07–3.65 | 0.81–3.40 |
| `e85246f`                |             255 | 0.79–3.53 | 0.77–1.31 | 0.69–0.85 |
| `8191b6d`, still running |              83 | 0.44–1.09 | 0.44–1.21 | 0.40–0.73 |

Against the query before, every other column is equal on the three commits;
the counts equal the lists' lengths on `e85246f` (144 and 30) and exceed them
in 16 of `242a9cf`'s 341 rows (192 failed and 75 flaky against 103 and 72).
Through the handlers, seven jobs' counts now equal the sum of their files'
(55, 19, 18, 10, 3, 174 and 24, where the jobs had said 36, 7, 8, 4, 2, 18 and
4), and the rest of each answer is the same. A job's files, two jobs in seven
rounds: the same rows with each count equal to its list's length, and no
faster, medians of 0.11 and 0.15 s where the lists took 0.12 and 0.15 s.
`EXPLAIN indexes = 1` selects the same parts and granules before and after:
636 and 98 `by_job` granules for `242a9cf`'s tests, 6 for a job's files.
