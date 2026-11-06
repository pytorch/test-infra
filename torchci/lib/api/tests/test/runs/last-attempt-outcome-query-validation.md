# Last-attempt outcome filter validation

Validated on 2026-10-24 against ClickHouse 26.6.1.2439 using SQL generated from
the working-tree test and commit run builders. The read-only connection used
`ci.runs`, disabled query caching and imposed a 90-second execution timeout.
[Recorded evidence](last-attempt-outcome-query-validation.json) includes the exact
DDL, parameters, SQL, EXPLAIN plans, complete returned rows and all timing samples.

The functional baseline adds `last_attempt_outcome` as an independent grouped
`HAVING` predicate. It selects `argMax(outcome, (started_at, ended_at, toString(id)))`
from every retained execution, after replacement resolution. Existing
`outcome`/`rerun_number` predicates still require one execution satisfying both;
that execution need not be the last one. Filtering occurs before cursor
pagination, and the attempts query continues to return every retained execution.

The candidate moved set membership inside `argMax`, returning a Boolean instead
of an outcome. Each variant received `EXPLAIN indexes=1` and `EXPLAIN PIPELINE`,
then three alternating pairs, reversing order for each pair. All 24 executions
returned exactly equal, nonempty, complete ordered rows, including cursor values.
No approximate functions or narrower retention ranges were introduced.

| Request                                                                        | Rows | Baseline median (range), seconds | Candidate median (range), seconds |
| ------------------------------------------------------------------------------ | ---: | -------------------------------- | --------------------------------- |
| Test, last passed                                                              |   26 | 0.142 (0.112–0.236)              | 0.378 (0.134–0.429)               |
| Test, failed attempt at rerun 0 and last passed; outcome/rerun/end-time sort   |   20 | 0.243 (0.117–0.283)              | 0.183 (0.159–0.191)               |
| Commit, last passed                                                            |   26 | 1.205 (0.894–1.331)              | 157.566 (146.761–237.149)         |
| Commit, failed attempt at rerun 0 and last passed; outcome/rerun/end-time sort |    7 | 1.771 (0.821–2.358)              | 193.601 (192.535–227.864)         |

The table is the 2026-11-03 replay, when the commit cases were regenerated for
the commit job lookup (the commit's jobs through the `head_sha` view, see the
[commit notes](../../commit/query-validation.md)) and the whole bundle was
remeasured against ClickHouse 26.6.1.2446: every execution returned the same
rows as before. The full `FINAL` read the commit candidates keep now reads the
whole retention, 150 to 240 s, where it took about 4.5 s on 2026-10-24; the
test fixture's failed-then-passed request returns 20 bundles where it returned 2. The functional checks below fetched their bundles' attempts with the
attempt fetch of that day, which reads `FINAL` only at the bundles' own starts
([attempt notes](attempts-query-validation.md)); the four checks whose
bundles were the same as on 2026-10-24 returned attempts identical to that
day's (equal digests), and the other two selected more bundles from the
newer data.

On 2026-11-05 the two commit cases were regenerated again, for the commit
page's index-analysis and exact-start changes (see the
[commit notes](../../commit/query-validation.md)), and for them the candidate
is now the baseline recorded until then, the working query as of 16fdbd5de,
not the rejected `argMax` variant: that variant's full `FINAL` read takes over
two minutes per execution and was not run again. Three alternating pairs
returned the same rows. Last passed: 1.316 s median (0.785–2.057) against
2.215 (2.018–3.013), 2.4 million rows read by both; failed attempt at rerun 0
and last passed: 0.740 (0.431–0.766) and 1.6 million rows against 3.605
(2.645–11.896) and 9.4 million. The table above keeps the 2026-11-03 figures.
The functional check `commit_failed_last_passed` ran again with the new query
and returned the same 7 bundles and 20 attempts (equal digest).

The two commit rows were remeasured on 2026-10-24 after the shared-start change:
their baseline is the working-tree SQL reading `FINAL` only at shared starts, while
the recorded candidate kept the full `FINAL` read, so those rows now compare the
pruned read with the full one rather than two `argMax` forms. For the test rows
the ranges overlap and shared-server read counters vary. The candidate did not
establish improvement beyond run-to-run noise, so the functional baseline is
retained with no speedup claim. The fixed fixtures are test
`16960517567045431281` and `pytorch/pytorch` commit
`9cc78e09ce3ea174d43897d70a5fea93d8caa34c`; the JSON records each full request.

EXPLAIN pruned the test read to 16–25 granules through its primary-key test ID.
The new commit filter requires replacement resolution, which cannot use the
direct `by_job` grouping optimization; in these plans the `FINAL` read covered
all retained run granules, and that cost grew with retention. Later on
2026-10-24 the commit page moved that read to the shared test starts only (see
the [commit notes](../../commit/query-validation.md)); the commit cases below
were regenerated and remeasured then. Queries omitting the filter keep their
existing SQL, including the default commit's `by_job` optimization.

Independent checks fetched every selected bundle's attempts with the working-tree
`FINAL` query and sorted them in JavaScript by start time, end time and UUID
string. These verified five last-failed bundles for test `58990344700751526`
(250 attempts), repeated `failed`/`passed` filter values, and the two test/seven
commit failed-then-passed bundles. Two consecutive `limit=2` pages matched the
first four rows of a `limit=4` request, including all cursor values. The original
commit fixture has no last-failed bundles; nonempty last-failed coverage uses
the separate test fixture above.

From `torchci/`, with Node 22 and dependencies installed:

```sh
node scripts/validateLastAttemptOutcomeQueries.cjs
node scripts/validateLastAttemptOutcomeQueries.cjs --live > last-attempt-validation.json
```

The first command verifies all recorded SQL against the current builders. Live
mode repeats the plans, alternating comparisons and independent attempt checks.
Connection settings come from `CLICKHOUSE_HUD_USER_*` or `.env.local`; no
credentials are recorded. Fixtures expire or change under retention and ingestion:
an empty or differing comparison fails and requires choosing new nonempty fixed
parameters and remeasuring.
