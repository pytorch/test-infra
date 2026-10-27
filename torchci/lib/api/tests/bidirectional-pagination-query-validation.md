# Bidirectional pagination SQL validation

Validated on 2026-10-24 against ClickHouse 26.6.1.2439 using SQL generated from
the working-tree builders for the test list, test runs and commit runs. The
[evidence bundle](validation/bidirectional-pagination-2026-10-24.json) records the
exact DDL, SQL, bindings, original forward rows, EXPLAIN plans and timing samples.
Queries ran sequentially, read-only, with query caching disabled and a 90-second
execution limit. No credentials are recorded.

The functional baseline reverses every sort comparison and SQL sort direction
for a previous-page cursor. It reverses null placement from `NULLS LAST` to
`NULLS FIRST`; values before a null anchor include nonnull values. The list layer
takes the requested number of nearest rows and restores the caller's requested
order. Filters, aggregation, replacement resolution and retention remain intact.

The original builders were copied before editing. Across seven fixed nonempty
requests, all **21** generated SQL/binding comparisons were unchanged for first
pages, explicit forward cursors and legacy cursors without direction. The two
changed SQL files only implement the new cursor direction; the commit builder
continues to use the shared run-page builder.

An optimization experiment factored the cursor predicate's repeated equality
prefixes into nested expressions. Each functional baseline and candidate
received `EXPLAIN indexes=1` and `EXPLAIN PIPELINE`, followed by three alternating
pairs with pair order reversed on alternate iterations. All **60** measured
executions returned exactly equal, nonempty, complete ordered rows, including
cursor values. Timings overlap, so the baseline is retained with no speedup claim.
No approximate functions, narrower time ranges or optimizer changes were added.

| Selection                                                     | Rows | Baseline median (range), seconds | Candidate median (range), seconds |
| ------------------------------------------------------------- | ---: | -------------------------------- | --------------------------------- |
| Tests, failure rate then descending run count                 |    4 | 0.443 (0.428–0.564)              | 0.521 (0.488–0.538)               |
| Tests, same selection, one-row probe                          |    1 | 0.434 (0.405–0.537)              | 0.436 (0.408–0.534)               |
| Tests, crossing the null-owner boundary                       |    4 | 0.279 (0.273–0.319)              | 0.312 (0.274–0.338)               |
| Test runs, ascending start time                               |    4 | 0.024 (0.021–0.024)              | 0.022 (0.022–0.034)               |
| Test runs, same selection, one-row probe                      |    1 | 0.020 (0.020–0.022)              | 0.022 (0.021–0.033)               |
| Test runs, null owner then descending start time              |    4 | 0.030 (0.028–0.030)              | 0.029 (0.029–0.030)               |
| Test runs, owner/time sort and repeated last-attempt outcomes |    4 | 0.035 (0.033–0.035)              | 0.034 (0.034–0.038)               |
| Commit runs, ascending start time                             |    4 | 0.426 (0.280–0.431)              | 0.368 (0.252–0.412)               |
| Commit runs, same selection, one-row probe                    |    1 | 0.420 (0.375–0.426)              | 0.413 (0.282–0.500)               |
| Commit runs, owner then descending start time                 |    4 | 0.432 (0.419–0.527)              | 0.504 (0.441–0.619)               |

The **35** independent navigation checks compare every returned column against
contiguous slices of the original forward queries. They cover forward and
backward pages, changing `limit` from 3 to 2, empty pages before the first row,
both directions of one-row probes, and an empty probe after the fully enumerated
health fixture. Real null owners, tied sort values, mixed ascending/descending
keys, and decimal IDs above JavaScript's safe integer range are represented.
The null-owner health case returns both null and nonnull rows in one backward
page; the null-owner run case checks tie-breaking within null values. The normal
commit fixture exercises the `by_job` projection. These checks validate SQL
selection; endpoint tests separately validate encoded links, enrichment and
response boundaries.

EXPLAIN retained the existing access paths: the sample test run pruned to
16 of 23,119 granules by test ID; the default and catalog-sorted commit pages
used `by_job`, pruning to 88 granules. The filtered health request selected its
existing window/source partitions and test IDs. Cursor comparison does not
avoid the underlying group aggregation.

For accurate boundary links on a nonempty cursor page, the list makes one
opposite-direction selection with internal `limit=0`, yielding SQL `LIMIT 1`.
It fetches no attempts or other enrichment. The measurements show that this
probe can cost about as much as the page-selection query itself: limiting output
to one row still reads and aggregates the matching scope. It adds latency on
cursor pages; initial and empty pages do not make this extra query. The recorded
figures are fixed filtered examples, not a latency guarantee for broad requests.

From `torchci/`, with Node 22 and dependencies installed:

```sh
node scripts/validateBidirectionalPaginationQueries.cjs
node scripts/validateBidirectionalPaginationQueries.cjs --live > pagination-validation.json
```

The offline command checks every recorded generated query against the working
tree. Live mode repeats plans, alternating equality/timing comparisons and
navigation checks using `CLICKHOUSE_HUD_USER_*` or `.env.local`. It does not run
deployed named queries. Health refreshes and retained runs can expire or change;
an empty comparison or changed rows fails validation and requires choosing new
fixed nonempty parameters and remeasuring. No instability occurred during this
recorded run. Fixed fixtures cover `pytorch/pytorch`, test IDs
`16960517567045431281` and `2916768648938826`, and commit
`9cc78e09ce3ea174d43897d70a5fea93d8caa34c`; the JSON is the complete parameter
reference.
