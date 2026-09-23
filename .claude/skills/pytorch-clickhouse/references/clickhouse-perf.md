# ClickHouse query performance — reference

Detailed companion to the `pytorch-clickhouse` skill. The main SKILL.md has the first-try checklist; this file has the full rules with mechanisms, examples, and version notes. Load it when writing or optimizing a non-trivial query. Rules are ordered by impact within each section — the top of each section is where most of the win is.

## Contents
- Prerequisite: read the DDL first
- Filtering & reading less data
- Deduplication & FINAL
- Joins
- Aggregation & GROUP BY
- PREWHERE, LIMIT, ALIAS
- CTEs & named subqueries
- Data types (query-relevant)
- Diagnosis workflow
- Table design & ingestion
- Version-sensitive behavior
- Sources

## Prerequisite: read the DDL first

Before writing a WHERE clause, run `get_clickhouse_schema(table)` and read the `CREATE TABLE`. The `ORDER BY` (sort key), any `PARTITION BY`, and any skip indexes decide which filters are fast. Writing a filter without knowing the sort key is guessing — and on this backend the guess is often wrong (see `workflow_job` below).

## Filtering & reading less data (the big levers)

1. **Filter on the sort-key prefix, left-to-right.** The primary index is sparse (one mark per 8192-row granule) and only prunes when the WHERE constrains the leftmost `ORDER BY` column(s). Skipping the prefix degrades to a slow generic-exclusion scan. Example: `ORDER BY (UserID, URL)` — filtering `UserID` read ~8K rows; filtering `URL` alone read ~8.8M.
   - HUD trap: `default.workflow_job` is `ORDER BY (id, run_id, dynamoKey)` — sorted by `id`, not time. `WHERE created_at > …` gets zero primary-key pruning; it relies entirely on the minmax skip index on `created_at`. A filter column that is neither in `ORDER BY` nor skip-indexed is a full scan.

2. **Never wrap a filter column in a function.** The index is built on raw stored values. `toDate(ts)=today()`, `lower(name)=…`, `toString(id)='5'` force per-row evaluation → full scan. Keep the column bare and transform the constant: `WHERE ts >= today() AND ts < today()+1`. Monotonic wrappers like `toStartOfHour(ts)` can still prune, but the range form is the safe default.

3. **Always bound time as a range** (`ts >= now() - INTERVAL 1 DAY`) — never an unbounded scan, never a function-wrapped equality.

4. **Select only the columns you need — never `SELECT *`.** Columnar storage means I/O scales with the number of columns read, not table width. `SELECT *` reads every column file and forfeits the columnar advantage.

5. **`col IN (a, b, c)` over long `OR` chains.** `IN` gives the optimizer a clean set it can turn into index checks; `OR` spanning different columns usually blocks index use on all of them.

## Deduplication & FINAL (all core HUD tables are SharedReplacingMergeTree)

6. **Data is not deduplicated until a background merge — which may never happen.** A bare SELECT can return duplicate or stale rows. Every query must dedup itself.

7. **Prefer `LIMIT 1 BY` / `argMax` over `FINAL`** for predictable latency:
   - Latest full row per key: `SELECT * FROM t ORDER BY _inserted_at DESC LIMIT 1 BY id`
   - Latest value of one column: `argMax(status, _inserted_at)`

8. **`FINAL` is merge-on-read — expensive.** Unfiltered `SELECT * … FINAL` was ~10× slower in Altinity's test and can OOM; automatic move-to-PREWHERE is off by default under FINAL (`optimize_move_to_prewhere_if_final=0`), so non-key filters are especially costly. If unavoidable: restrict columns, filter on key columns, and set `do_not_merge_across_partitions_select_final=1`.

**Caveat — check whether the sort key ends in a per-row unique column before trusting FINAL or `argMax`.** ReplacingMergeTree collapses on the *whole* `ORDER BY`, so a sort key terminating in an emission id, uuid, or insert-sequence column gives every row a distinct key and `FINAL` collapses nothing — it is not merely slow, it is a no-op that silently returns every row. `argMax` over a single version column has the matching failure: it picks one row per key but discards any tiebreak the table carries beyond that column.
- HUD example: `misc.greenlight_pr_state` is `ORDER BY (repo, pr_number, run_id, emit_id)`. Measured live: 904 rows plain, **904 rows under `FINAL`**, 133 under `LIMIT 1 BY pr_number`. `argMax(status, version)` drops the `run_id` tiebreak that makes concurrent emissions resolve deterministically. The correct read is `ORDER BY pr_number, run_id DESC, version DESC LIMIT 1 BY pr_number`.

## Joins

**Correctness first — `join_use_nulls` is `0` on this cluster (verified live).** An unmatched LEFT/RIGHT/FULL JOIN row does not fill with NULL; it fills with the column's **type default**: `0` for numerics, `''` for String, `1970-01-01 00:00:00` for DateTime/DateTime64. Consequences, all measured:
- **`IS NULL` never detects a miss.** `isNull()` returns 0 on every filled column. Test for the miss with the type default, or set `join_use_nulls=1` for that query and handle real NULLs.
- **Epoch fills flow silently into arithmetic.** Subtracting two timestamps across an unmatched LEFT JOIN yields a ~56-year duration that lands in your quantiles without raising anything.
- **Predicate direction decides the answer.** With the fill on the right, `left.ts > right.ts` is **true for every miss** (any real timestamp beats the epoch) while `right.ts > left.ts` is false for every miss. Write the comparison so a miss falls on the side you intend.
- **Aggregates differ in safety.** `max(<bool expr>)` over a LEFT JOIN is safe — a miss contributes `0`. `count(right_col)` is **not**: the filled default is a real value, so each miss over-counts by one. Use `countIf(<match predicate>)` instead.

9. **Smaller table on the RIGHT.** ClickHouse builds the in-memory hash table from the right side; the wrong order ran ~5× slower and used ~9 GiB vs ~700 MiB. CH ≥24.12 auto-reorders 2-table joins, but explicit order is still the safe default.

10. **Filter and aggregate before the join**, in a subquery per side — the base execution model runs the join before WHERE/GROUP BY. Don't rely on filter pushdown.

11. **Use `IN (subquery)` when you only need to filter, not fetch columns** — it builds one hash set and can use the primary index. Don't inline millions of literals; use a subquery or temp table.

12. **`dictGet` for dimension lookups** instead of joining a small static table — no build phase, ~25× faster. Dictionaries dedup on key, so they're unsafe for one-to-many relations.

13. **Identical join-key types on both sides.** `UInt64` vs `String`, or `Nullable` vs non-nullable, forces per-row casts and blocks sort-order use.

14. **Pick `join_algorithm` for the memory budget.** Default hash/parallel_hash OOMs if the right table exceeds RAM; `grace_hash` / `full_sorting_merge` spill to disk instead.

## Aggregation & GROUP BY

15. **Filter rows in WHERE/PREWHERE, never HAVING.** HAVING runs after grouping — reserve it for conditions on the aggregate itself.

16. **Use approximate aggregates on high cardinality** — `uniqCombined(x)` (state capped ~96 KiB) over `count(DISTINCT x)`/`uniqExact` (unbounded, OOMs); `quantile()` (reservoir sampling) over `quantileExact`; `topK(N)(x)` over `GROUP BY … ORDER BY count() DESC LIMIT N`.

17. **Segment in one pass with conditional aggregation** — `countIf(status='ok')`, `sumIf(cost, region='us')` instead of separate subqueries or unions.

18. **Batch quantile levels:** `quantiles(0.5, 0.9, 0.99)(x)` shares one state; three separate `quantile*` calls do not.

19. **`SET optimize_aggregation_in_order=1`** when GROUP BY keys are a sort-key prefix — streams each group out instead of holding the whole hash table.

20. **Cap GROUP BY memory** on high-cardinality keys: `max_bytes_before_external_group_by` to spill to disk, with `max_memory_usage` ≈ 2× that (the merge stage needs RAM again).

21. **`LIMIT n BY key`** for top-N-per-group — cheaper than window functions or self-joins.

## PREWHERE, LIMIT, ALIAS

22. **Trust auto-PREWHERE.** Override manually only to force a small, highly-selective column ahead of large SELECT columns (so the big columns are read only for rows that pass).

23. **`ORDER BY <sort-key-prefix> LIMIT N` enables early termination** (`optimize_read_in_order`, default on). Bare `LIMIT` with no `ORDER BY` is fast but non-deterministic; the optimization doesn't apply under GROUP BY or FINAL.

24. **Don't filter on ALIAS columns** — they're computed per-row at query time, so no index. On HUD, `log_url` and `repository_full_name` are ALIASes. `MATERIALIZED` columns are stored and indexable.

## CTEs & named subqueries

The Postgres intuition — "the CTE runs once, then everyone reads the result" — is **wrong here, in both of ClickHouse's two `WITH` forms**. Neither materializes.

25. **`WITH x AS (SELECT …)` is re-executed at every reference site.** N references cost N independent scans, not one. Verified live: `WITH t AS (SELECT number AS n, rand() AS r FROM numbers(4)) SELECT a.r = b.r FROM t AS a INNER JOIN t AS b ON a.n = b.n` returns `0` on every row — the two sides got different random values because `t` ran twice. So a CTE over a 250k-row scan referenced four times is a million rows read.
   - Fix: **reference each CTE once.** Restructure so the work happens in one place — fold the second use into the first with conditional aggregation, or `UNION ALL` the two populations and tag them with a discriminator column. ClickHouse has no CTE-materialization hint; if a single reference is genuinely impossible, materialize into a temporary table yourself. Flat CTEs referenced once each are the shape that stays fast.

26. **`WITH <expr> AS <alias>` (the scalar form) is substituted textually into the AST at every use — so nesting multiplies.** A scalar defined in terms of other scalars expands combinatorially, and the cost is paid at parse time before any data is read. Verified live: five scalars each concatenating the previous one five times parses fine; **one more level fails outright** with `Code: 168 … AST is too big. Maximum: 500000: (after expansion of aliases). (TOO_BIG_AST)`. The same shape short of the ceiling just gets slow — a real query hit 13 seconds purely in expansion.
   - Fix: **keep scalar aliases one level deep.** A scalar that reads a parameter or a table is fine; a scalar that reads another scalar that reads another is the trap. `max_expanded_ast_elements` is `500000` on this cluster.

## Data types (query-relevant)

27. **`Nullable` hurts** — it adds a separate null-mask column and, by default, cannot be part of the primary key or a skip index. Prefer a sentinel default.

28. **`LowCardinality(String)`** helps under ~10K distinct values and becomes harmful over ~100K.

29. **Don't `JSONExtract` from a String column in the hot path** — it parses the whole blob per row. Promote hot keys to typed or `MATERIALIZED` columns.

30. **Reading a `Map` reads the whole map** per row; use `.keys`/`.values` sub-columns, or dedicated columns for a small fixed key set.

## Diagnosis workflow

31. **Verify pruning with `EXPLAIN indexes = 1`** — read `Granules: kept/total`. `64/27704` is a tight prune; `27700/27704` is a full scan (the filter isn't hitting the key). On CH ≥25.9 add `SETTINGS use_query_condition_cache=0, use_skip_indexes_on_data_read=0` for meaningful output.

32. **Full loop:** `EXPLAIN indexes=1` (pruning) → `EXPLAIN ESTIMATE` (parts/rows/marks) → run with `measure_performance=true` (duration_ms, memory) → iterate. Benchmark cold when comparing.
   - HUD note: `system.query_log` is permission-denied for our user, so `get_query_execution_stats` and log-based inspection don't work — `EXPLAIN` plus measured runs are the instruments. `lint_clickhouse_query` is currently broken.

## Table design & ingestion (only when creating/altering tables)

- Lead the sort key with the most-filtered low-cardinality columns; 3–5 columns is plenty. `PRIMARY KEY` may be a short prefix of a longer `ORDER BY`.
- Don't over-partition — partitioning is for data management (TTL, tiering), not query speed. Keep partition-key cardinality low (month-grained is typical).
- Match a codec to the data shape: `CODEC(Delta, ZSTD)` for timestamps and incrementing IDs, `Gorilla` for float gauges, `T64` for small-range ints (not random ones). Chain `ZSTD` after; level >3 rarely pays.
- Batch inserts (10K–100K rows) or use async inserts; row-by-row inserts cause "too many parts" and slow every SELECT.
- Data-skipping indexes only help when the column correlates with the sort order; confirm with `EXPLAIN indexes=1` before keeping one.
- Avoid `OPTIMIZE … FINAL` and routine `ALTER … UPDATE/DELETE` mutations in production.
- Projections and materialized views precompute heavy queries; an incremental MV is an insert trigger, not an auto-refreshing view — it won't backfill history.

## Version-sensitive behavior

`parallel_hash` default and 2-table auto join-reorder (24.12), JSON type GA (25.3), lazy materialization (25.4), `EXPLAIN indexes=1` needs the cache settings above (25.9+), FINAL multi-threaded (22.6), `parts_to_throw_insert` 300→3000 (23.6). Verify on the target server before relying on newer settings.

## Sources

Official docs (clickhouse.com/docs): sparse primary indexes, choosing a primary key, skipping indexes, PREWHERE, SELECT, JOINs, join algorithm, GROUP BY, ORDER BY, FINAL / ReplacingMergeTree, EXPLAIN, query optimization, data types (LowCardinality, Nullable), column codecs. ClickHouse blog: "10 best practice tips", the "ClickHouse fully supports JOINs" series, "common getting-started issues", compression posts. Altinity KB: pick-keys, the ReplacingMergeTree deep-dive, monotonic functions.
