# Summary SQL validation

What `GET /api/tests/summary` costs the database, why its six figures are
read in three statements, and evidence that they are the figures a statement
per figure returns. Measured 2026-11-24 against production ClickHouse
26.6.1 through HUD's database user, for `pytorch/pytorch`, while the health
table was at its 23:00, 23:15 and 23:30 UTC refreshes. The statements were
built from the working tree by the builders the endpoint calls and sent with
`@clickhouse/client`, `use_query_cache = 0` and `wait_end_of_query = 1`.
Server time is `elapsed_ns` of `X-ClickHouse-Summary`. Wall time is the
client's clock over the statements of one summary sent together, as the
endpoint sends them, network included. Runs alternate between the versions
compared, and every run was warm. The server is shared: one statement's time
varied up to threefold between rounds, so compare medians and ranges, not
single runs. This user cannot read `system.query_log`, so there is no CPU time here; a
run with `max_threads = 1` stands in for CPU-seconds.

The standing evidence is [query-validation.json](query-validation.json):
six summary requests, each with the six statements from before and the
three or four of the working tree, their plans, and four alternating pairs of the two
versions sent together, with every figure compared in every pair.
`node scripts/validateSummaryQueries.cjs` replays it: without `--live` it
checks that the recorded statements are still what the builders write, which
`yarn test` runs, so a change to the SQL fails until the bundle is recorded
again; `--live` repeats the plans and the comparison; `--record` writes them
back. The tables below are from the longer runs made while choosing the
design, by scripts that are not checked in.

Those runs are of 2026-11-24 as it then was: the list's default window was 12
hours, so "the default request" in them is the 12-hour one, and the first view
was Failing, counted the failing rows alone and named no window. Three things
changed later that day:

- The default window became 3 hours. No statement's text changed: a request
  that names no window binds `3h`.
- The first view became Unhealthy, whose figure counts the failing and the
  flaky rows. No statement's text changed: its status binds two values where
  it bound one.
- The first view was given the default window as its own, as Blocking
  viable/strict has its 12 hours: it is the default table, and without a
  window of its own the tests page marked it in every window. In a window that
  is not the default its figure is therefore no longer over the rows of the
  other views of `main` and is read alone, so a request there has four
  statements where it had three: the first figure's, new, and the shared one
  without it. A request in the default window is unchanged.

The bundle was recorded again on 2026-11-25 for all three
([The recorded bundle](#the-recorded-bundle)), with the earlier default kept
as a case of its own, `twelve_hours`.

## What is read

The health table had 92 parts and 11,105 granules. A statement reads one
`(ran_on, window)` partition, all of it, and the catalog's IDs of the
repository to match it against (`ci.tests`, 1.25 M stored rows, 1.24 M of
them `pytorch/pytorch`):

| Partition           | Parts | Rows    | Granules |
| ------------------- | ----- | ------- | -------- |
| `main`, 12h         | 4     | 5.21 M  | 620      |
| `pull_request`, 12h | 8     | 6.98 M  | 853      |
| `main`, 14d         | 10    | 13.09 M | 1,608    |
| `pull_request`, 14d | 8     | 13.69 M | 1,678    |

`EXPLAIN indexes = 1` for every statement, before and after: the min-max
index on the partition key keeps the partition's parts (4 of 92, 620 of
11,105 granules for `main`, 12h) and the primary key prunes nothing inside
it, as nothing can: a figure is of the whole partition. `EXPLAIN ESTIMATE`
gives the rows above.

The 3-hour partitions, which a request that names no window reads since
2026-11-24, at the 01:15 UTC refresh of 2026-11-25, when the table had 90
parts and 11,092 granules and `main`, 12h held 5.22 M rows in 624 granules:

| Partition          | Parts | Rows   | Granules |
| ------------------ | ----- | ------ | -------- |
| `main`, 3h         | 3     | 4.28 M | 512      |
| `pull_request`, 3h | 4     | 3.49 M | 426      |

Their plans are the others': the partition's parts kept whole (3 of 90, 512
of 11,092 granules for `main`, 3h) and nothing pruned inside.

## Before: a statement per figure

Six statements, each `SELECT … FROM combined_health WHERE <the view's
filters>` (commit `a4ec85c0d`). Where one count's time goes, written by hand
over `main`, 12h (median server time):

| Read                                                       | Server time |
| ---------------------------------------------------------- | ----------- |
| The partition's row count                                  | 8 ms        |
| The status of every row, no catalog match (the wrong rows) | 86 ms       |
| Every row matched against the catalog, `tests_id IN (…)`   | 286 ms      |
| The status of every matched row (the failing count)        | 321 ms      |

Matching the partition against the catalog is most of every statement, and
six statements did it six times. Spelling the status as comparisons of the
counts instead of `multiIf(…) IN (…)` changed nothing (332 against 321 ms).

Blocking viable/strict was the slowest by far, 767 ms where the other counts
took about 240: it filters on the workflow paths, an array per row. Its plan
(`EXPLAIN actions = 1`) put every predicate in one `PREWHERE`, the test of
the paths ahead of the status, so `arraySort(arrayDistinct(workflow_paths))`
was computed for all 5.2 M rows to count 10. Variants of that one statement
(median of 6 alternating runs; bytes are uncompressed):

| Variant                                                  | Server time | Read   |
| -------------------------------------------------------- | ----------- | ------ |
| As it was: `WHERE hasAny(paths, …) AND status IN (…)`    | 767 ms      | 281 MB |
| The status written first                                 | 769 ms      | 281 MB |
| As it was, `allow_reorder_prewhere_conditions = 0`       | 384 ms      | 96 MB  |
| As it was, `move_all_conditions_to_prewhere = 0`         | 291 ms      | 322 MB |
| By hand: `PREWHERE` the status, `WHERE` the paths        | 185 ms      | 185 MB |
| Shipped: `WHERE` the status, `countIf(hasAny(paths, …))` | 228–280 ms  | 80 MB  |

The order the predicates are written in does not matter, the server
reorders them; the two settings help but leave the choice to its heuristics.
The shipped form needs neither: a `WHERE` runs before an aggregate's
argument is computed, so the paths are read only in the granules where a
row of that status is.

## After: three statements

`buildFigureStatements` (`query.ts`) groups the figures by the
`combined_health` rows they are read over. The four views of `main` in the
request's window (Unhealthy, Flaky on main, Slowest, Most CI time) differ only
in their status filter, so one statement reads those rows once and answers
each with its own aggregate (`countIf`, `max` and `argMaxIf`, `sum`).
Blocking viable/strict searches an array and Flaky on PRs reads the other
code source, so each has a statement to itself, with its status as the
`WHERE`. Since 2026-11-25 the first view keeps the default window, so in any
other window it is a third figure with a statement to itself, a count over
`main` in 3 hours with its statuses as the `WHERE`, and the shared statement
answers the other three: four statements. What that costs is under
[The recorded bundle](#the-recorded-bundle).

Sent together, as the endpoint sends them (default threads):

| Window | Version | Wall, median (p25–p75) | Server time, summed | Rounds |
| ------ | ------- | ---------------------- | ------------------- | ------ |
| 12h    | Six     | 831 ms (816–847)       | 2,013 ms            | 24     |
| 12h    | Three   | 338 ms (314–361)       | 774 ms              | 24     |
| 14d    | Six     | 863 ms (833–895)       | 2,520 ms            | 16     |
| 14d    | Three   | 543 ms (438–572)       | 1,135 ms            | 16     |

Each alone (median server time; default threads, then one thread; Failing is
the first view as it then was, counting the failing rows alone):

| Statement                                            | 12h    | 12h, 1 thread | 14d    | 14d, 1 thread |
| ---------------------------------------------------- | ------ | ------------- | ------ | ------------- |
| Before: Failing                                      | 281 ms | 386 ms        | 314 ms | 998 ms        |
| Before: Blocking viable/strict                       | 767 ms | 1,057 ms      | 779 ms | 1,118 ms      |
| Before: Flaky on main                                | 236 ms | 393 ms        | 272 ms | 987 ms        |
| Before: Flaky on PRs                                 | 237 ms | 517 ms        | 326 ms | 1,004 ms      |
| Before: Slowest                                      | 220 ms | 622 ms        | 330 ms | 1,374 ms      |
| Before: Most CI time                                 | 173 ms | 294 ms        | 257 ms | 527 ms        |
| After: Failing, Flaky on main, Slowest, Most CI time | 297 ms | 819 ms        | 346 ms | 1,813 ms      |
| After: Blocking viable/strict                        | 280 ms | 461 ms        | 228 ms | 462 ms        |
| After: Flaky on PRs (as before)                      | 233 ms | 604 ms        | 291 ms | 958 ms        |

With one thread the six statements sum to 3.3 s for the default request and
6.0 s for 14 days, the three to 1.9 s and 3.2 s. That is far under the ten
CPU-seconds at which a query joins the heavy workload ([Heavy
queries](../../../../app/api/README.md#heavy-queries)), so the statements run
outside it.

Through the endpoint, on a dev server on the measuring machine, the
statements are a part of the wait. A round trip to the database took about
55 ms from there on a kept connection and about 280 ms on a new one, and a
summary makes three, one after another: the refresh, the statements, the
slowest test's row. With no answer kept and no connection open, the default
summary took 0.89 to 1.10 s end to end and a 14-day one 0.93 s; with every
answer kept and connections open, 0.18 s.

The endpoint keeps each statement's answer in the server's query cache for a
minute, keyed by the refresh it binds. Checked with the settings the app
sends: the first statement took 276 ms and read 6.46 M rows; asked again at
the same refresh it took 3 ms and read the one kept row; asked at another
refresh it read the 6.46 M rows again.

## Same figures

The baseline is the six statements as committed, over the same list request
as the new statements, with no refresh between the two reads (the comparison
is repeated when one lands). On production, for 18 requests, every figure
is equal, 15 of them with figures above zero: `pytorch/pytorch` in each of
the six windows; in 12h and 14d with `language` python, cpp, both and
unknown; `pytorch/executorch` in 12h and 14d, and in 14d with python; and a
repository the catalog does not know. For example, 14d: 3,038 failing, 10
blocking, 1,600 and 2,291 flaky, a slowest mean of 7,803,887 ms and
772,328,692,843 ms in all, from both. The 2026-11-25 record compares its six
requests the same way, the baseline being the committed builders run over the
views as they are now, so that both versions count the failing and the flaky
rows for Unhealthy, over the default window whatever the request's: every
figure is equal in every pair. For the default request, 49 unhealthy, 10
blocking, 44 and 43 flaky, a slowest mean of 1,510,559 ms and 6,038,239,432
ms in all; for 14 days, the same 49 and 10, 1,612 and 2,275 flaky, 7,803,887
ms and 772,492,285,748 ms.

The slowest figure names a test, so it takes the largest by the mean and
then by the test's ID, smallest first, where the list orders by the three
IDs: the other two only order one test's rows. On an embedded ClickHouse
(chdb 4.5.1, engine 26.11) holding the checked-in `ci` DDL and synthetic
rows, a figure of each kind over 52 requests (through both code sources and
every kind of filter) equals the list's own statement on the same data: the
count its number of rows, the total their sum, the slowest the test of its
first row, in 42 of the requests chosen among different tests tied for the
largest mean and in 6 with no such test. The 42 figures of seven summaries,
read as the endpoint groups them, equal their views' lists, and 28 counts
equal a tally made without SQL.

The list's own statements are untouched: for those 52 requests at two page
sizes, the list's SQL and bindings are text for text what the committed
builder writes.

## Tried and not kept

- **One statement, each selection a branch of a `UNION ALL`.** It builds the
  catalog's set once: 493 ms of server time against 966 for three statements
  in the same rounds (12h), 582 against 1,253 (14d). The reader waits no
  less, 551 against 487 ms and 645 against 629, since the branches share one
  query's threads. Three statements were kept: the same wait, and each
  answer kept and failing on its own.
- **Matching the catalog with a `LEFT SEMI JOIN` instead of the `IN` set.**
  Alone, each statement is about 55 ms faster (193, 168 and 176 ms against
  255, 220 and 232; ten rounds). Sent together the difference is inside the
  noise, 369 against 394 ms of wall (ranges 300–620 and 306–567). Not kept:
  the figures would no longer read the list's own selection as the list
  writes it. It is the next thing to try for both, since the match is most
  of what is left; for the list, weigh that a search narrows the set to a
  few tests, which an `IN` set can prune by the primary key and a join
  cannot (not measured here).
- **`use_index_for_in_with_subqueries = 0`**, so the set is not also
  prepared for an index it cannot prune with: 234 against 260 ms, inside the
  noise.
- **Blocking viable/strict in the shared statement** when its window is the
  request's. The paths are then read for every row: 425 ms for the shared
  statement with it against 216 ms without, where the count on its own takes
  174 ms; sent with the rest, 517 against 383 ms of wall.
- **The slowest by other keys** (the shared statement, one thread, 12h):
  ordered by the mean and all three IDs 1,020 ms; by the mean and the test's
  ID, shipped, 799 ms; packed into one `UInt128`, 800 and 781 ms. Leaving
  ties unbroken, which is not the same answer, 727 ms.
- **Repeating a lone figure's status inside its aggregate** as well as in
  the `WHERE`: no difference (544 against 541 ms, 482 against 486, one
  thread), so the shorter statement is the one built.

## The recorded bundle

Recorded on 2026-11-25 between 02:31 and 02:33 UTC, within the 02:15 UTC
refresh, on ClickHouse 26.6.1.2455, after the three changes above: four pairs
a case (median wall time of the statements sent together; server time, rows
read and peak memory summed over them). The baseline's six statements are the
committed builders' over the views as they are now, the first view's over the
default window whatever the request's.

| Case                                   | Version      | Wall     | Server time | Rows read | Memory    |
| -------------------------------------- | ------------ | -------- | ----------- | --------- | --------- |
| `default` (3h), three statements       | Six          | 1,510 ms | 3,525 ms    | 32.5 M    | 1,124 MiB |
| `default` (3h), three statements       | Working tree | 456 ms   | 1,061 ms    | 16.6 M    | 648 MiB   |
| `twelve_hours`, four                   | Six          | 917 ms   | 2,416 ms    | 39.6 M    | 1,325 MiB |
| `twelve_hours`, four                   | Working tree | 572 ms   | 1,252 ms    | 26.7 M    | 1,012 MiB |
| `fourteen_days`, four                  | Six          | 752 ms   | 2,456 ms    | 67.8 M    | 1,627 MiB |
| `fourteen_days`, four                  | Working tree | 658 ms   | 1,691 ms    | 39.9 M    | 999 MiB   |
| `three_days_python`, four              | Six          | 764 ms   | 2,044 ms    | 41.9 M    | 1,352 MiB |
| `three_days_python`, four              | Working tree | 500 ms   | 1,131 ms    | 28.3 M    | 997 MiB   |
| `another_repository` (14d), four       | Six          | 1,107 ms | 2,211 ms    | 67.7 M    | 1,391 MiB |
| `another_repository` (14d), four       | Working tree | 568 ms   | 1,473 ms    | 39.9 M    | 753 MiB   |
| `unknown_repository` (no tests), three | Six          | 86 ms    | 140 ms      | 7.5 M     | 99 MiB    |
| `unknown_repository` (no tests), three | Working tree | 82 ms    | 81 ms       | 3.8 M     | 50 MiB    |

One statement peaked at 485 MiB at most (the three figures of `main` over 14
days). A repository the catalog does not know costs almost nothing either
way: its set is empty, and the primary key then prunes the whole partition.
The server was busier than for the earlier records: the default request's six
statements, unchanged since the record of an hour before, ranged from 765 to
1,841 ms where they had a median of 832. Compare the versions of a case, not
a case across records.

What the fourth statement costs, alternating the three statements from before
the first view kept its own window (its figure read with the other views of
`main`, over the request's window) and the working tree's four, ten times
each within the same refresh:

| Request  | Version | Wall, median (range) | Server time | Rows read | Memory    |
| -------- | ------- | -------------------- | ----------- | --------- | --------- |
| 12 hours | Three   | 348 ms (261–498)     | 814 ms      | 21.4 M    | 799 MiB   |
| 12 hours | Four    | 350 ms (296–979)     | 1,032 ms    | 26.7 M    | 957 MiB   |
| 14 days  | Three   | 417 ms (367–917)     | 938 ms      | 34.6 M    | 845 MiB   |
| 14 days  | Four    | 420 ms (324–605)     | 1,167 ms    | 39.9 M    | 1,066 MiB |

The wait is the same, since the statements run together; the server reads
`main`, 3 hours once more, about 220 ms and 5.3 M rows. Every figure but the
first is equal between the two; the first is the functional change, 49 over 3
hours where it was 190 over 12 hours and 4,649 over 14 days. Nothing else
reads `main`, 3 hours in another window, so there is no statement for it to
share. With one thread, each statement alone (median of five runs), the
first figure's own statement takes about 0.35 s, and the statements sum to
1.4 s for the default request's three, 2.3 s for the four of 12 hours and
3.4 s for the four of 14 days: still far under the ten CPU-seconds of the
heavy workload.

Earlier records, each replaced by the next:

- 2026-11-25, 01:27 UTC, within the 01:15 refresh: after the default window
  and the first figure's count changed, the first view still without a window
  of its own, so three statements for every request. Six against three: the
  default request 832 against 364 ms of wall, 12 hours 747 against 369, 14
  days 797 against 400, 3 days of Python 758 against 390, the other
  repository 1,034 against 431, the unknown one 78 against 76. The default
  request waited as long at 3 hours as at 12, 364 against 369 ms: a 3-hour
  partition is four fifths of a 12-hour one on `main`, and Blocking
  viable/strict reads its 12 hours either way. For the 12-hour request the
  three statements were, text for text, those of the record before; the one
  binding that differed was the first figure's status,
  `["failing", "flaky"]` where it was `["failing"]`.
- 2026-11-24, at the 23:45 UTC refresh: the default 12 hours, the first
  figure a count of failing rows. 862 against 401 ms for the 12-hour request,
  946 against 634 for 14 days, 1,002 against 652 for 3 days of Python, 1,242
  against 502 for the other repository and 78 against 78 for the unknown one.

## Not measured

No view reads two code sources, so a statement over rows grouped per
configuration was checked for meaning (on chdb) and never timed. Measure
again, and record the bundle again, after a view is added or changed, after a
retention change, and if the catalog match is rewritten.
