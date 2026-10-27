# Bidirectional pagination SQL validation

Recorded on 2026-10-26 (03:28 to 03:30 UTC) against ClickHouse 26.6.1.2439,
database `ci`, with SQL generated from the working-tree builders for the test
list, test runs and commit runs. The
[evidence bundle](validation/bidirectional-pagination-2026-10-26.json) records
the exact DDL, SQL, bindings, reference rows, EXPLAIN plans and timing samples.
Queries ran sequentially, read-only, with query caching disabled and a 90-second
execution limit. No credentials are recorded. The bundle was first recorded on
2026-10-24, when the previous-page support was added, and re-recorded after the
list gained its `status` and `status_rank` columns and its 12-hour default
window; the tests fixtures now pin `window=7d`, the window they were first
recorded with, so a change of the default leaves them as they are.

The functional baseline reverses every sort comparison and SQL sort direction
for a previous-page cursor. It reverses null placement from `NULLS LAST` to
`NULLS FIRST`; values before a null anchor include nonnull values. The list layer
takes the requested number of nearest rows and restores the caller's requested
order. Filters, aggregation, replacement resolution and retention remain intact.

Across seven fixed nonempty requests, the bundle pins **21** generated
SQL/binding pairs for first pages, explicit forward cursors and legacy cursors
without direction; when the previous-page support was added, these were
unchanged against the builders of the time, and the offline replay keeps them
matching the working tree. The commit builder continues to use the shared
run-page builder.

An optimization experiment factored the cursor predicate's repeated equality
prefixes into nested expressions. Each functional baseline and candidate
received `EXPLAIN indexes=1` and `EXPLAIN PIPELINE`, followed by three alternating
pairs with pair order reversed on alternate iterations. All **60** measured
executions returned exactly equal, nonempty, complete ordered rows, including
cursor values. Timings overlap, so the baseline is retained with no speedup claim.
No approximate functions, narrower time ranges or optimizer changes were added.

| Selection                                                     | Rows | Baseline median (range), seconds | Candidate median (range), seconds |
| ------------------------------------------------------------- | ---: | -------------------------------- | --------------------------------- |
| Tests, failure rate then descending run count                 |    4 | 0.418 (0.412–0.419)              | 0.446 (0.431–0.468)               |
| Tests, same selection, one-row probe                          |    1 | 0.493 (0.484–0.519)              | 0.620 (0.520–0.672)               |
| Tests, crossing the null-owner boundary                       |    4 | 0.314 (0.262–0.361)              | 0.310 (0.296–0.368)               |
| Test runs, ascending start time                               |    4 | 0.032 (0.026–0.043)              | 0.047 (0.031–0.068)               |
| Test runs, same selection, one-row probe                      |    1 | 0.030 (0.029–0.043)              | 0.039 (0.029–0.070)               |
| Test runs, null owner then descending start time              |    4 | 0.035 (0.034–0.035)              | 0.037 (0.037–0.038)               |
| Test runs, owner/time sort and repeated last-attempt outcomes |    4 | 0.053 (0.050–0.058)              | 0.051 (0.044–0.058)               |
| Commit runs, ascending start time                             |    4 | 0.378 (0.321–0.385)              | 0.367 (0.287–0.418)               |
| Commit runs, same selection, one-row probe                    |    1 | 0.392 (0.272–0.457)              | 0.371 (0.343–0.378)               |
| Commit runs, owner then descending start time                 |    4 | 0.733 (0.622–0.933)              | 1.134 (0.551–1.277)               |

The **35** independent navigation checks compare every returned column against
contiguous slices of the reference forward queries, read live in the same run.
They cover forward and backward pages, changing `limit` from 3 to 2, empty pages
before the first row, both directions of one-row probes, and an empty probe
after the fully enumerated health fixture. Real null owners, tied sort values,
mixed ascending/descending keys, and decimal IDs above JavaScript's safe integer
range are represented. Each standard reference has 13 rows and anchors its pages
at row 8; the null-owner health fixture enumerates whole (40 rows at this
recording, the last three with a null owner) and anchors at its second-to-last
row, so one backward page returns both null and nonnull rows and the end probe
reads past its last row; the null-owner run case checks tie-breaking within
null values. The normal commit fixture exercises the `by_job` projection. These
checks validate SQL selection; endpoint tests separately validate encoded
links, enrichment and response boundaries.

EXPLAIN retained the existing access paths: the sample test run pruned to
42 of 64,097 granules by test ID; the default and catalog-sorted commit pages
used `by_job`, pruning to 88 of 64,099 granules. The filtered health request
selected its window/source partitions (1,086 of 10,781 granules) and then its
test IDs (934 of 1,086; 4 of 1,086 for the null-owner fixture). Cursor
comparison does not avoid the underlying group aggregation.

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
node scripts/validateBidirectionalPaginationQueries.cjs --record
```

The offline command checks every recorded generated query against the working
tree; `yarn test` runs it too. Live mode repeats plans, alternating
equality/timing comparisons and navigation checks against the recorded bundle,
using `CLICKHOUSE_HUD_USER_*` or `.env.local`. Record mode rebuilds the bundle:
it reads each reference page live, derives every cursor from the rows at the
fixtures' anchors (the recorded cursors are positions, so a cursor from an
earlier recording would no longer point into live data), generates the SQL
from the working tree, runs the live checks and writes the file; it is how to
re-record after a change to the list, run or commit builders. Neither mode runs
deployed named queries. Health refreshes and retained runs can expire or
change; an empty comparison or changed rows fails validation and requires
choosing new fixed nonempty parameters (the `FIXTURES` table in the script) and
re-recording. No instability occurred during this recorded run. Fixed fixtures
cover `pytorch/pytorch`, test IDs `16960517567045431281` and
`2916768648938826`, and commit `9cc78e09ce3ea174d43897d70a5fea93d8caa34c`;
the JSON is the complete parameter reference.
