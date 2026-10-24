# Run catalog expansion: SQL validation

These are historical implementation measurements, not verification of the current
working tree. Their raw artifacts were not retained in the repository. For current
defaults, checked-in SQL evidence and the runnable validation procedure, see
[Tests API SQL validation](../../query-validation.md).

Validated on 2026-10-22 against the live read-only ClickHouse database. SQL was
generated from the working-tree `buildRunCatalogQuery` and executed with
bound parameters and query caching disabled. This query expands only the
configurations on the returned page for both run endpoints; the run selection
and cursor SQL are unchanged. The previously validated SQL moved from
`commit/catalog-query.ts` to `runs/catalog-query.ts` without changing its text.

The query reuses the list endpoint's test and configuration projections.
`FINAL` preserves the catalogs' earliest `first_seen_at` and the owners table's
latest row for each `(repo, file)`. Left joins retain configurations with missing
catalog rows. Explicit presence flags distinguish a missing row from a genuine
catalog ID of zero, and requested IDs remain available as decimal strings.

## Fixed fixture and correctness

The 100 input runs comprise 97 evenly spaced records from the retained-run
reference for `pytorch/pytorch` commit
`8caf0da8a5061291f1186f976bdbf7f8eda89ab1`, one repeated record, and two synthetic
missing configurations with all IDs respectively `0` and `18446744073709551615`.
The real configurations use environment `2081130751942693630` and env-var set
`5021553704861139757`.

Every execution returned exactly 99 unique configuration rows: 97 complete
catalog records with owners and two missing records with empty owner arrays and
zero presence flags. All three requested UInt64-max IDs remained exact decimal
strings. Comparisons sorted complete JSON rows without dropping any columns;
all 20 alternating baseline/candidate executions matched the original functional
baseline exactly. No table mutations, approximate functions or time filters were
used.

## EXPLAIN and retained optimization

The functional baseline joins the requested tuples to the full `FINAL` test,
owner, environment and env-var catalogs. The retained candidate adds exact
requested-ID filters inside the three ID catalog subqueries. Owners remain
joined by both repository and file.

`SHOW CREATE TABLE` confirmed that tests, environments and env-var sets use
`SharedAggregatingMergeTree`, ordered by `id`, while owners use
`SharedReplacingMergeTree(created_at)`, ordered by `(repo, file)`.
`EXPLAIN indexes=1` succeeded for all variants. The requested-ID filter reduced
test granules from 94 to 87 and environment granules from 2 to 1; owner and
env-var granules remained 2 and 1. The widely distributed test hashes explain
the modest pruning. Filtering before building the catalog join also reduced
the measured query memory substantially.

Queries alternated baseline/filter for four pairs; all timings below include
every measured run and are server elapsed seconds.

| Variant               | Server seconds             | Median seconds | Rows read | Bytes read  |
| --------------------- | -------------------------- | -------------- | --------- | ----------- |
| Full catalog baseline | 0.900, 0.282, 0.268, 0.330 | 0.306          | 996,873   | 129,503,796 |
| Exact ID filters      | 0.199, 0.099, 0.095, 0.095 | 0.097          | 932,651   | 121,298,647 |

The exact-ID candidate was faster in every pair. Reported memory was 82–97 MB
versus 348–365 MB. These are fixture measurements, not a latency guarantee.

A second candidate moved the same immutable ID predicates to `PREWHERE`. It
remained equivalent, but it won only three of six pairs, with overlapping
timings in both execution orders:

| Pair ordering        | WHERE seconds       | PREWHERE seconds    |
| -------------------- | ------------------- | ------------------- |
| WHERE / PREWHERE × 3 | 0.146, 0.124, 0.108 | 0.195, 0.079, 0.097 |
| PREWHERE / WHERE × 3 | 0.141, 0.147, 0.094 | 0.084, 0.218, 0.096 |

The `WHERE` variant is retained; no additional latency improvement is claimed
for `PREWHERE`, and optimization stopped at that result. The generated SQL and parameters matched the retained variant at that stage.

## HTTP verification

The live endpoint returned 25 expanded runs by default, with expanded object
IDs matching the raw run IDs and test/owner values matching the existing test
detail endpoint. A filtered 48-run result paginated as 20, 20 and 8 records;
concatenating those pages exactly matched the unpaged response. Invalid SHA,
missing repository, mismatched cursor repository, method rejection, empty
results and the expanded OpenAPI response reference also passed.

After sharing the implementation between both run endpoints, 96 regression
cases (48 per endpoint) preserved the SQL, parameters, normalized queries and
cursor encoding. The moved catalog query preserved the complete 99-configuration result. A live HTTP comparison returned
the same complete expanded run from both endpoints and verified identical
OpenAPI response schemas and shared parameters. Cursors remained scoped to their
originating endpoint.
