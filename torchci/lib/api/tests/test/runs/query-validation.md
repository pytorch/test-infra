# Test runs API: live SQL validation

These are historical implementation measurements, not verification of the current
working tree. Their raw artifacts were not retained in the repository. For current
defaults, checked-in SQL evidence and the runnable validation procedure, see
[Tests API SQL validation](../../query-validation.md).

Validated on 2026-10-22 using SQL generated from the working-tree
`buildRunsQuery`, normalized parameters, and direct read-only ClickHouse
requests with query caching disabled. The actual `listRuns` function and Next.js
HTTP route were exercised separately. No database objects were modified.

## Schema and replacement semantics

`SHOW CREATE TABLE fortesting.runs` confirmed all ten returned columns. The
three foreign keys are `UInt64`; `github_workflow_job_id` is signed `Int64`;
`report_uuid` is `UUID`; `rerun_number` is `UInt16`; outcome is an `Enum8`;
outcome summary is a string. Both timestamps are non-nullable
`DateTime64(3, 'UTC')`.

The table uses `SharedReplacingMergeTree` without a version column. Its full
replacement key is `(tests_id, environments_id, env_vars_id, started_at,
github_workflow_job_id, rerun_number)`, and the primary key is the first four
columns. The partition is `toDate(started_at)` with a 14-day TTL. Queries retain
`FINAL`, use the complete identity to break ordering ties, and add no time
restriction. The API exposes everything currently retained by the table.

`ended_at` is outside the replacement key. An actual ended-at cursor query
passed `EXPLAIN actions=1,indexes=1` and `EXPLAIN PIPELINE`: `FINAL: 1` is present,
and the cursor filter consumes the output of `ReplacingSorted`. Explicit
`optimize_move_to_prewhere_if_final=0` preserves this ordering.

## Fixed requests and optimization comparison

Both requests use test **8392283225797466657**, which had 1,955 retained runs
across 12 environment/env-var combinations. No fixture time range was added.

| Request  | Additional parameters                                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default  | Defaults: `sort=-started_at`, `limit=25`; no environment filters                                                                                                     |
| Filtered | `environments_id=6736396900082420103` or `2867127138932093158`; `env_vars_id=1688593832548410197` or `13616850606107544956`; `sort=ended_at,-started_at`; `limit=25` |

The functional baseline places the test ID and optional configuration filters
in `WHERE`. The only candidate moves those immutable identity predicates into
explicit `PREWHERE`, leaving cursor predicates in `WHERE`. It preserves
`FINAL`, every selected column, time coverage, ordering and limit.

Both versions passed `EXPLAIN indexes=1`. Test-ID primary-key pruning retained
190/664,597 granules for the initial default baseline and 129/664,528 for the
candidate. The filtered plans used all three identity predicates and retained
155/664,714 and 163/664,724 granules, respectively. Parts and granule counts
changed between requests as ingestion and background merging continued. Both
versions considered every partition, and the pruning conditions were equal.

All **22 executions** returned exactly equal complete rows within their fixed
request, including the extra lookahead row and every cursor sort value:
14 executions for the default and eight for the filtered request, each
returning 26 rows. One warmup per variant was excluded from each initial block;
the reversed default block followed without another warmup.

| Request / order               | WHERE server seconds | PREWHERE server seconds | WHERE / PREWHERE median seconds |
| ----------------------------- | -------------------- | ----------------------- | ------------------------------- |
| Default, WHERE then PREWHERE  | 0.342, 12.128, 0.574 | 0.067, 0.796, 6.202     | 0.574 / 0.796                   |
| Default, PREWHERE then WHERE  | 4.221, 0.211, 0.141  | 3.699, 0.080, 0.074     | 0.211 / 0.080                   |
| Filtered, WHERE then PREWHERE | 0.815, 0.089, 0.052  | 0.067, 0.076, 0.139     | 0.089 / 0.076                   |

PREWHERE reduced bytes read from approximately 65–77 MB to 36–40 MB, and
reported memory from approximately 103–143 MB to 11–36 MB. Latency ranges
overlapped substantially and the initial default comparison did not improve.
The **WHERE baseline is retained**; no latency speedup is claimed and no further
rewrite was introduced after the candidate failed to beat timing variation
consistently.

## Live behavior and independent oracles

- An independent raw `FINAL` query returned all 1,955 fixture rows. Sorting
  those rows outside ClickHouse matched all ten fields in the first two
  default API pages, with no environment or env-var restriction.
- Six historical rows selected by two environment IDs and two env-var IDs
  were traversed completely with `limit=2`. All four single-field timestamp
  directions and both `ended_at,-started_at` and `-ended_at,started_at` matched
  independent sorting exactly: six rows in three pages each, with no duplicate
  or missing identities. Millisecond timestamp precision was preserved.
- Environment-only, env-var-only, and combined repeated filters matched the
  independent oracle. The combined wider fixture selected 1,240 rows before
  pagination, confirming OR within each field and AND across fields.
- Every live response passed `RunListPageSchema`; issued cursors decoded and
  matched their requests. Missing test ID `0` and an absent environment ID
  returned empty pages with null cursors.
- A read-only, hand-authored seven-row fixture exercised tied timestamps,
  adjacent UInt64 IDs above `2^53`, maximum UInt64, minimum/maximum Int64 job
  IDs, rerun ties, and zero-duration skipped runs through the actual list and
  cursor code. All six orderings returned exactly the expected seven complete
  rows in four pages each. An exact latest-row aggregation modeled one replaced
  row whose old `ended_at` differed. This validates cursor behavior over the
  modeled replacement result; it does not create or test duplicate stored
  MergeTree parts. The live fixture had no duplicate replacement identities.
- An actual Next.js HTTP smoke with the live database returned the six-row
  fixture in three pages, exactly equal to `limit=100`. Invalid IDs returned
  400; POST returned 405 with `Allow: GET`; test ID `0` returned 200 with an
  empty page.

## Outcome filter validation

Validated the optional repeated `outcome` filter on 2026-10-22 with direct
read-only requests, query caching disabled, and no additional time restriction.
The functional baseline is byte-for-byte the previous query plus only the
bound `run.outcome IN {outcome: Array(String)}` predicate and its parameter.
Omitting `outcome` generates exactly the previous SQL and parameters, checked
for both first-page requests below and cursors for all six timestamp orderings.

Fresh DDL confirmed that outcome is outside the replacement key.
`EXPLAIN actions=1,indexes=1` and `EXPLAIN PIPELINE` on both first-page requests
and a combined-filter ended-at cursor confirmed `FINAL: 1`; the outcome and
cursor predicates consume the output of `ReplacingSorted`. The existing
`optimize_move_to_prewhere_if_final=0` remains necessary.

Both optimization fixtures use test **8392283225797466657** and `limit=25`:

| Request        | Filters and ordering                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Single outcome | `outcome=skipped`; default `sort=-started_at`                                                                                                                                                    |
| Combined       | `environments_id` in `2867127138932093158`, `9741020469863285637`; `env_vars_id` in `13616850606107544956`, `4601352097872804797`; `outcome` in `passed`, `skipped`; `sort=ended_at,-started_at` |

The candidate moves only immutable identity filters into explicit `PREWHERE`,
keeping outcome and cursor filters in `WHERE` after replacement. Both variants
used identical primary-key conditions. Initial EXPLAINs retained 99/665,881
and 101/665,883 granules for the single-outcome baseline and candidate, and
105/665,915 and 101/665,910 for the combined request. Background ingestion and
merging account for changing part counts; every partition remained eligible.

Each request ran four alternating baseline/candidate pairs, excluding the
first pair as warmups. All **16 executions** returned identical complete
ordered rows within their fixture: 26 rows including lookahead and cursor
values.

| Request        | WHERE server seconds | PREWHERE server seconds | WHERE / PREWHERE median seconds |
| -------------- | -------------------- | ----------------------- | ------------------------------- |
| Single outcome | 0.432, 0.089, 0.100  | 0.020, 0.107, 0.091     | 0.100 / 0.091                   |
| Combined       | 0.193, 0.097, 0.096  | 0.269, 0.128, 0.138     | 0.097 / 0.138                   |

The candidate did not consistently beat run-to-run variation, so the
**WHERE functional baseline is retained** and no speedup is claimed. The final
generated SQL and parameters match the measured baseline exactly.

An independent raw `FINAL` query returned all 1,955 retained fixture rows.
Filtering and sorting those rows outside ClickHouse matched all ten fields
returned by the actual `listRuns` function:

- All 1,324 passed rows were traversed in 14 pages and all 631 skipped rows in
  seven pages, using `limit=100`, with no duplicate or missing identities.
- Repeated outcomes together with two environment IDs and two env-var IDs
  selected 29 rows containing both outcomes. All six timestamp orderings
  traversed them in five pages each with `limit=7`, exactly matching the oracle.
- Environment-plus-outcome, env-var-plus-outcome, and all three filters together
  matched independent filtering. Restricting the combined fixture to skipped
  returned exactly one row. Valid outcome `failed`, absent from this test,
  returned an empty page with a null cursor.
- Every response passed `RunListPageSchema`; cursors matched the normalized
  query and rejected a changed outcome. Omitting the filter preserved the
  default page.

This live fixture contains passed and skipped outcomes and no duplicate
replacement identities; replacement ordering is verified by the query plans.
