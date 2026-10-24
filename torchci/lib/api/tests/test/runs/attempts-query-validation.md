# Attempt bundle SQL validation

Validated on 2026-10-24 against `ci` using SQL generated from the working tree.
[The evidence](attempts-query-validation.json) records SQL, bound parameters, live
DDL, both EXPLAIN plans, alternating timings, row counts and complete-row hashes.
All requests were read-only with query caching disabled. No schema, retention
range or approximate function changed.

The response collection was subsequently renamed from `retries` to `attempts`.
The generated SQL and bound parameters remain identical to the measured versions;
the renamed replay script verifies that identity without new timing claims.

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

The unchanged commit statistics continue counting individual executions. The
UUID lookup is also unchanged; its group keys now feed the shared attempt fetch.

## Retained optimizations

For a commit page whose ordering and filtering use only replacement-key values,
`by_job` can supply the groups directly. Duplicate stored versions cannot change
a group's existence, its minimum start time, or whether a rerun-number predicate
matches. This is equivalent to grouping the deduplicated executions. An outcome
filter or sorting by end time, outcome or rerun number requires the `FINAL`
baseline. Only requested aggregate columns are read. In particular, the fast
path reads no mutable execution values. Catalog and workflow fields depend only
on group foreign keys. Every returned execution is still fetched with `FINAL`.

Attempt fetching explicitly filters the first three group columns, which form the
primary-key prefix, in `PREWHERE`. These are replacement-key columns, so all
versions of each selected execution remain eligible. The complete group predicate
in `WHERE` also selects the job. This reduces payload columns read without
changing the selected granules or allowing old versions to survive.

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
