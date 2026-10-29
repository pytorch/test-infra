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
| Test, last passed                                                              |   26 | 0.022 (0.022–0.203)              | 0.024 (0.024–0.025)               |
| Test, failed attempt at rerun 0 and last passed; outcome/rerun/end-time sort   |    2 | 0.028 (0.026–0.044)              | 0.028 (0.027–0.028)               |
| Commit, last passed                                                            |   26 | 1.025 (0.983–1.061)              | 4.508 (4.453–4.558)               |
| Commit, failed attempt at rerun 0 and last passed; outcome/rerun/end-time sort |    7 | 1.122 (1.109–1.177)              | 4.430 (4.244–4.536)               |

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
