# Attempt bundle SQL validation

Validated on 2026-10-24 against `ci` using SQL generated from the working tree.
[The evidence](attempts-query-validation.json) records SQL, bound parameters, live
DDL, both EXPLAIN plans, alternating timings, row counts and complete-row hashes.
All requests were read-only with query caching disabled. No schema, retention
range or approximate function changed.

The response collection was subsequently renamed from `retries` to `attempts`.
The generated SQL and bound parameters remained identical to the measured versions;
the renamed replay script verifies that identity without new timing claims.
On 2026-11-03 the attempt fetch began reading `FINAL` only at the bundles' own
starts and the commit cases began finding the commit's jobs through the
`head_sha` view; those cases were regenerated and remeasured that day, a
commit page's fetch was added, and each says so in its `regenerated` or
`note` field (see Exact starts below).

## Semantics and baseline

A bundle contains every retained execution sharing
`(tests_id, environments_id, env_vars_id, github_workflow_job_id)`, across reports.
The initial execution is included. Both filters on individual executions must
match the same execution: `countIf(outcome matches AND rerun_number matches) > 0`.
They select the bundle without removing its other attempts. Grouping and cursor
pagination precede fetching the selected bundles' complete executions.

The functional baseline groups `ci.runs FINAL`, retains the existing catalog,
workflow and commit membership logic, and orders and limits the groups. Start
sorting uses `min(started_at)` and end sorting uses `max(ended_at)`. Outcome and
rerun-number sorting use the last chronological execution, including executions
which did not match an attempt filter. Chronology compares `started_at`,
`ended_at`, then the canonical UUID string: `toString(id)` deliberately avoids
ClickHouse's different UUID ordering. Group foreign keys resolve all remaining
ties. The attempt-fetch baseline reads `FINAL` and matches complete group keys in
`WHERE`, with no attempt filter or limit.

The commit statistics were unchanged by this step; they later moved to bundle
counts by final outcome (see the [commit notes](../../commit/query-validation.md)).
The UUID lookup is also unchanged; its group keys now feed the shared attempt
fetch.

## Retained optimizations

For a commit page whose ordering and filtering use only replacement-key values,
`by_job` can supply the groups directly. Duplicate stored versions cannot change
a group's existence, its minimum start time, or whether a rerun-number predicate
matches. This is equivalent to grouping the deduplicated executions. An outcome
filter or sorting by end time, outcome or rerun number requires replacement
resolution; at this measurement that was the `FINAL` baseline, and since
2026-10-24 a commit page reads `FINAL` only at shared test starts (see the
[commit notes](../../commit/query-validation.md)). Only requested aggregate
columns are read. In particular, the fast
path reads no mutable execution values. Catalog and workflow fields depend only
on group foreign keys. Every returned execution is still fetched with `FINAL`.

Attempt fetching explicitly filtered the first three group columns, which form the
primary-key prefix, in `PREWHERE`, until 2026-11-03 (see Exact starts below).
These are replacement-key columns, so all versions of each selected execution
remain eligible. The complete group predicate in `WHERE` also selects the job.
This reduced payload columns read without changing the selected granules or
allowing old versions to survive.

## Alternating comparison

Every case below received `EXPLAIN indexes=1`, `EXPLAIN PIPELINE`, and three
alternating pairs, reversing the pair order each time. All 60 executions returned
exactly the same nonempty, complete ordered rows as their functional baseline,
including all cursor values. Timings are server execution medians in milliseconds;
they are not complete API latencies or comparisons with the old unbundled API.

| Case                                              | Rows | Baseline | Current |
| ------------------------------------------------- | ---: | -------: | ------: |
| Commit default                                    |   26 |    2,605 |     359 |
| Commit catalog sort                               |   26 |    2,786 |     624 |
| Commit rerun filter and catalog sort              |    7 |    2,864 |     547 |
| Commit second page                                |   26 |    2,433 |     261 |
| Commit combined attempt filters and mutable sorts |    7 |    3,817 |   3,594 |
| Test default                                      |   26 |       25 |      12 |
| Test combined attempt filters and mutable sorts   |    2 |       25 |      20 |
| Test catalog and workflow sorts                   |   26 |      113 |     124 |
| Fetch one attempt bundle                          |    2 |       22 |      10 |
| Fetch a page's complete attempts                  |   26 |      159 |      93 |

The commit fixture is `pytorch/pytorch`, SHA
`9cc78e09ce3ea174d43897d70a5fea93d8caa34c`. The test fixture is
`16960517567045431281`. The combined-filter cases request `outcome=failed`,
`rerun_number=0`, and `sort=outcome,rerun_number,-ended_at`. These cases also verify
that the live legacy analyzer resolves the qualified execution references in
`HAVING` correctly alongside the aggregate aliases.

The default commit plan changes from all 18,921 run granules to 88 of 18,917
`by_job` granules. Totals vary with concurrent ingestion. The attempt page keeps
191 selected granules; bytes read fall from 219.7 MB to 71.4 MB. Test and mutable
commit queries retain the baseline plan; their small timing differences do not
establish a speedup.

An exact-partition discovery candidate was explained and compared on default and
mutable commit pages in another three alternating pairs each. All rows matched,
but it did not improve latency or prune materially, so it was rejected. Its SQL,
plans and measurements are retained under `rejected_alternatives`. No additional
rewrite was retained after the measured improvements above.

## Exact starts (2026-11-03)

Until 2026-11-03 the attempt fetch filtered the configurations' primary-key
prefix, `(tests_id, environments_id, env_vars_id)`, in `PREWHERE`, and the
complete group keys in `WHERE`. That kept every version of each selected
execution, but it read every retained run of every selected configuration, in
every part: on a commit page of 100 bundles, 95 configurations of 80 tests in
54 jobs on commit `ce6ff46`, `FINAL` kept 7,462 granules in 138 of 140 parts
and read 61 million rows, 3.2 GB, to return 235 attempts. A busy test runs in
every commit, so the read grew with the retention, not with the page.

Now a plain read of the bundles' rows, without `FINAL`, finds the
`(tests_id, environments_id, env_vars_id, started_at)` of every execution they
hold. The group columns lead the `by_job` projection's key, job and then test,
so that read takes only those jobs' rows. Those four columns are the primary
key, so `FINAL` then reads only the granules holding these starts, in the
partitions of their days: 178 granules in the 2 parts of the commit's days,
2.5 million rows and 125 MB in all. It is the same set of rows. Every stored
version of an execution shares its replacement key, so it shares its start,
and the plain read finds the start of every execution of the bundles. The
`PREWHERE` filters replacement-key columns only, so every version of a
selected execution stays eligible and `FINAL` resolves it as before. The
complete group keys in `WHERE` then drop other jobs' executions that share a
start. No time window bounds the read, and there is still no report, outcome
or rerun-number restriction on the returned attempts.

The replay compared the three fetch cases with their baselines in three
alternating pairs each, at the server's default thread count, and every
execution returned identical complete rows:

| Case                   | Bundles | Attempts |     Before, server seconds |               After | Rows read, before → after |
| ---------------------- | ------: | -------: | -------------------------: | ------------------: | ------------------------: |
| `attempts_commit_page` |     100 |      235 | 1.070 (0.877–15.012, cold) | 0.300 (0.223–0.419) |           61.1 M → 2.53 M |
| `attempts_page`        |      26 |       26 |        2.361 (0.621–5.181) | 0.107 (0.076–0.113) |           23.3 M → 0.25 M |
| `attempts_group`       |       1 |        2 |        0.262 (0.219–0.363) | 0.018 (0.018–0.021) |           1.05 M → 0.04 M |

`attempts_commit_page` is new: the first 100 bundles of `ce6ff46`'s default
page, its before the fetch as the builder wrote it until this change, so its
first, cold execution (15 s) is what a commit page paid. The other two cases
keep the functional baseline they were recorded with on 2026-10-24, a `FINAL`
read matching each complete group in `WHERE`. Measured alone at the heavy
workload's four threads the same day, the commit page's fetch took 2.5 to 22
s before (the first cold) and 0.37 to 0.55 s after, and a test page's 0.25 to
0.61 s against 0.06 to 0.13 s.

The same day the commit cases were regenerated for the commit job lookup (see
the [commit notes](../../commit/query-validation.md)) and replayed against
their 2026-10-24 baselines, with identical complete rows. Those baselines
group every row of the commit's partitions through `FINAL`, which now reads
10.6 billion rows, 420 GB, in 110 to 255 s per execution, against 0.2 to 1.8 s
for the pages; replaying them is the expensive part of this bundle.

## Real attempts across reports

The fixed test fixture contains a failed execution followed by a passed execution
in the same report; fetching the matching failure includes both rows. A second
live bundle demonstrates a process restart and counter reset:

- Test `199796844191533405`, environment `3918732538669420041`, env-var set
  `1688593832548410197`, job `120790198655`.
- `1691e322-bbd1-4c55-847d-49ec0dcf1b40`: failed, rerun 0.
- `3bfeac3b-9f48-40e6-a22f-05398e17a6da`: crashed, rerun 1, same report.
- `4bc92f75-4036-413b-a762-c5dea6f9cad0`: passed, rerun 0, a new report.

The shared attempt query returns all three in chronology. Neither report UUID nor
rerun number splits this bundle.

## Reproduce

From `torchci`, run `node scripts/validateRunAttemptsQueries.cjs` to check the
recorded current SQL and parameters against the working-tree builders. Add
`--live` to repeat the EXPLAIN plans and alternating exact comparisons, using the
normal read-only credentials from `.env.local`. Optional case names restrict the
run, for example `--live commit_default attempts_group`. The existing 14-day TTL
can expire these fixtures; a live replay refuses empty comparisons.
