# Run detail: live SQL validation

Validated on 2026-10-24 against `ci` using SQL generated from the working-tree
query builders. [The evidence](query-validation.json) includes exact SQL, bound
parameters, live DDL, EXPLAIN plans, alternating timings and complete-row hashes.
All requests were read-only with query caching disabled. No table, retention
range or approximate function changed.

## Identity and replacement semantics

Live `ci.runs` is a `SharedReplacingMergeTree` with no version column. Its UUID
`id` is neither indexed nor part of the replacement key. The primary key is
`(tests_id, environments_id, env_vars_id, started_at)`; the replacement key adds
`github_workflow_job_id, rerun_number`.

The functional baseline selects the requested fields from `ci.runs FINAL`,
filters the bound UUID in `WHERE`, and uses `LIMIT 2` so the API can detect
conflicting IDs. Moving that UUID predicate into the FINAL read's `PREWHERE`
would be incorrect: an older version carrying the UUID could survive after
its replacement was filtered out.

The optimized query first discovers primary-key prefixes through a scan of the
UUID column without `FINAL`. This yields a safe superset of the requested run's
prefixes. It then reads those prefixes with `FINAL`, checking the UUID only
after replacement deduplication. Every version of each selected replacement
key remains eligible. `optimize_move_to_prewhere_if_final=0` preserves that
ordering. A replacement carrying another UUID makes the older UUID unavailable.

## Lookup measurements

The fixed run UUID was `53e65f6c-d68a-4b5c-a994-a2a1ce874ac4`. Four alternating
pairs, reversing pair order each time, returned the same complete nonempty row
in all eight executions. The optimized main read retained **1 of 18,591
granules**; discovery still scanned all retained UUIDs, about 152 million rows.
No time restriction was added to discovery or the final read.

| Variant                  | Server seconds, each execution | Median seconds |     Bytes read |
| ------------------------ | ------------------------------ | -------------: | -------------: |
| Simple `FINAL` baseline  | 4.941, 5.458, 4.340, 4.859     |          4.900 | 16.49–16.53 GB |
| Primary-prefix discovery | 0.490, 0.353, 0.228, 0.283     |          0.318 | 2.437–2.438 GB |

An initial candidate discovered full replacement keys and also checked full-key
membership after FINAL. That version matched the same baseline in another
eight executions. Removing the redundant full-key predicate retained exact
results in eight additional alternating executions between the two candidates.
Their timings overlapped (the simpler candidate took 0.193–0.236 seconds;
the full-key candidate took 0.188–1.568 seconds), so no additional speedup is
claimed for that simplification and optimization stopped. Memory is not
compared because HTTP summary headers did not consistently contain final
counters; timings and byte counts above use the completed JSON statistics.

The nil UUID lookup returned no rows. An exact scan found zero nil UUIDs among
152,327,324 stored rows. This is an observation of this database snapshot,
not an additional validity rule for UUID parameters.

## Existing run lists

The existing list builders change only by selecting `id` in their run source
and output columns. For each case below, the working-tree SQL and bindings were
byte-for-byte equal to the original builder plus those two functional changes.
Both copies received EXPLAIN and three alternating pairs. Every execution
returned exactly the same 26 ordered complete rows, including UUID and cursor
values. No list speedup is claimed; no other list rewrite was introduced.

| Case              | Fixed request                                              | Before / after median seconds |
| ----------------- | ---------------------------------------------------------- | ----------------------------: |
| Test default      | Test `8392283225797466657`, `sort=-started_at`, limit 25   |                 0.059 / 0.031 |
| Test catalog join | Same test, `sort=file,-started_at`, limit 25               |                 0.035 / 0.039 |
| Commit default    | `pytorch/pytorch`, SHA below, `sort=-started_at`, limit 25 |                 0.434 / 0.465 |
| Commit union      | Same commit, `sort=-ended_at`, limit 25                    |                 0.549 / 0.558 |

The commit fixture was `9cc78e09ce3ea174d43897d70a5fea93d8caa34c`. The two commit
cases exercise both the page-key FINAL read and the direct/FINAL union. The
catalog sort exercises the test list's run subquery. UUIDs were present in
all returned rows, including all union branches.

## Route smoke

The route was also exercised with live ClickHouse data for the lookup fixture.
An uppercase UUID returned 200 with its normalized UUID, passed
`RunDetailSchema`, and included test, workflow and report metadata. A ranged
GET to the returned report URL returned 206. The nil UUID returned the expected
404 body, and malformed UUID input returned 400. The full expanded response's
`query_duration_ms` was 3,070 ms, including its three database calls; this is
separate from the lookup-only timings above.

These measurements describe the recorded SQL and live data at this timestamp.
To repeat them, execute the evidence's SQL and parameters through the normal
read-only ClickHouse client with its recorded settings, run both `EXPLAIN
indexes=1` and `EXPLAIN PIPELINE`, then alternate baseline and current SQL.
Compare complete rows exactly and require nonempty results; fixtures can expire
under the existing 14-day TTL. List baselines are identical to their recorded
current SQL after the requested UUID projection.
