# Run filter and sort SQL validation

These are historical implementation measurements, not verification of the current
working tree. Their raw artifacts were not retained in the repository. For current
defaults, checked-in SQL evidence and the runnable validation procedure, see
[Tests API SQL validation](../../query-validation.md).

Validated on 2026-10-22 using SQL generated from the working-tree
`buildRunsQuery` and `buildCommitRunsQuery` functions. These checks used the
read-only ClickHouse HTTP connection, with query caching disabled. They did not
use deployed named queries.

## Behavior and query scope

Both endpoints apply catalog, owner, environment-variable and workflow-path
filters before cursor pagination. Catalog sorts use the same fields and owner
ordering as the test listing. Missing catalog values and empty owner sets sort
last in either direction; an existing empty string or zero device count remains
distinct from missing data. Outcome sorting compares its string label rather
than its Enum8 ordinal.

The actual run selection still uses `runs FINAL` (then `fortesting.runs`, now `ci.runs`). Mutable outcome
and end-time predicates remain after deduplication, with
`optimize_move_to_prewhere_if_final = 0`. Joins require wrapping that scoped read
in a subquery because ClickHouse rejects `PREWHERE` on a joined SELECT. The
commit's existing exact job and partition restrictions remain inside that read.

Catalog and workflow IDs are discovered from the same scope and immutable run
identity filters. This discovery can read without `FINAL` because those IDs are
replacement-key columns; it only supplies lookup keys, not returned run rows.
It also retains the commit's exact partition restriction. No arbitrary time
window or approximate operation was introduced. Workflow metadata selects the
same latest retained job/workflow rows as page enrichment.

## Equivalence and alternating measurements

The nonempty comparison fixture was:

- Repository: `pytorch/pytorch`.
- Commit: `8caf0da8a5061291f1186f976bdbf7f8eda89ab1`.
- Environment: `2081130751942693630`.
- Environment-variable set: `5021553704861139757`.
- Outcomes: `skipped`, `xfailed`; limit: `100`.
- Sort: `file,workflow_path,owner,device_count,outcome,rerun_number,-started_at`.

Each query returned all 48 matching runs. The functional baseline added the
requested filters and sorts to the existing run selection, with catalog/job ID
discovery before pagination. Each rewrite was explained and compared over four
alternating pairs, reversing the order on successive pairs. All 24 timed results
matched the baseline's complete ordered rows, including every returned run
column and all cursor sort values. Their canonical JSON SHA-256 was
`ed6591af3cd0a859393eb88ed3846e1bfea510af131b013646a95df556285b19`.

| Comparison                                                                        | Baseline median (range), seconds | Rewrite median (range), seconds | Decision                                                                     |
| --------------------------------------------------------------------------------- | -------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Add exact commit partition restriction to metadata ID discovery                   | 16.228 (9.339–23.549)            | 9.954 (4.567–49.000)            | Retain exact partition pruning; timings had substantial shared-server noise. |
| Read the full needed test catalog and use all matched commit jobs for metadata    | 4.169 (3.484–8.964)              | 5.344 (4.483–10.123)            | Reject; reduced read volume did not improve latency.                         |
| Move metadata ID restrictions into explicit `PREWHERE` on the preceding candidate | 3.198 (1.888–6.188)              | 4.701 (3.825–10.299)            | Reject; no improvement beyond noise.                                         |

The retained query uses scoped catalog/job ID discovery. The first rewrite
reduced reported reads from approximately 6.16 billion to 1.09 billion rows,
including repeated metadata scope lookups. The other candidate reduced reads
further to approximately 534 million but was not faster in its alternating
comparison, so it was removed. These measurements do not establish a general
API latency improvement.

`EXPLAIN indexes = 1` on the retained query showed the run read restricted to
6 parts and 3,076 of approximately 670,000 granules. The scoped catalog lookup
contained 339 test IDs. The workflow lookup read 2 of 32,078 job granules and
5 of 14,621 workflow granules. The unbounded discovery baseline instead read
essentially every run granule. The final regenerated working-tree SQL and
parameters matched the measured retained variant exactly.

## Additional coverage

An unfiltered commit request with `sort=file,owner` and `limit=25` also retained
the exact 6-part/3,076-granule run scope. Catalog discovery found 580,424 test
IDs. Three executions returned the same 26 rows, including the lookahead row,
in 5.995, 3.382 and 5.802 seconds. Their complete-row SHA-256 was
`d526719eb1e135de5ca3afb32adfaa0b9ec8348a2603eeec1c2fb35fa92c7fa4`.

Live HTTP checks independently sorted the expanded 339-run fixture, paginated
the 48 nonpassed runs, exercised every new filter and sort on both endpoints,
and checked missing map keys, literal empty workflow paths and changed-filter
cursors. Cursor tests additionally cover nulls, empty strings, numeric zero,
both directions and identity ties. The existing timestamp-only SQL and bound
parameters remained identical in all 192 legacy compatibility cases, rerun
against the retained working tree.
