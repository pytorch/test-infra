# Analyzer migration patterns for HUD queries

Companion to `../SKILL.md`. Each entry gives the **symptom** (what `scripts/compare_analyzers.py`
or HUD shows), the **cause**, the **fix**, and **how to verify** it. Part A lists what we found by
running all 217 saved queries (177 top-level, 40 nested such as `vllm/*`) on both analyzers
against production (HUD ClickHouse Cloud 26.6.1.2455, `compatibility = 24.2`, `join_use_nulls =
0`, November 2026). Part B lists documented incompatibilities that no HUD query hit, so you can
recognise them. Part C covers testing traps that produce false verdicts.

The greps below are leads, not a census: a static scan for `) FINAL` reported 0 matches and
missed `JOIN pushes AS p FINAL` on a CTE. Run the comparison on every query you migrate.

## Contents
- A1 FINAL on a CTE or subquery (`UNSUPPORTED_METHOD`)
- A2 FINAL on the right-hand table of a JOIN (silent count change)
- A3 Window function with LIMIT BY or ORDER BY on an unselected expression (old-analyzer bugs)
- A4 ROW_NUMBER / argMax / any over ORDER BY ties
- A5 Benign nondeterminism: classify, don't fix
- A6 `IS NULL` after a LEFT JOIN on a non-Nullable column (pre-existing bug)
- A7 Scalar subquery that looks correlated but is not (pre-existing bug)
- A8 Dead and broken-regardless queries
- B  Documented incompatibilities HUD did not hit
- C  Testing traps

---

## A1. FINAL on a CTE or subquery

- **Symptom:** `breaks_on_new` with `UNSUPPORTED_METHOD (1): Table expression modifiers FINAL are
  not supported for subquery pushes AS p FINAL`. (Code 181 is the same idea for a table engine
  that does not support FINAL.)
- **Cause:** `FINAL` written after a CTE name or a derived table. The old analyzer silently
  ignored it; the new one rejects it.
- **Fix:** delete that `FINAL`. That keeps the old behaviour exactly, because it never did
  anything. If deduplication is needed, put `FINAL` on the base table *inside* the CTE (it usually
  is already there).

  ```sql
  -- before (master_commit_red_percent): pushes is a CTE that already reads push FINAL
  WITH pushes AS (SELECT ... FROM default.push p FINAL WHERE ...)
  ... FROM default.workflow_job j FINAL
      join pushes p FINAL on j.head_sha = p.sha
  -- after
  ... FROM default.workflow_job j FINAL
      join pushes p on j.head_sha = p.sha
  ```
- **Verify:** `compare_analyzers.py master_commit_red_percent --b-sql fixed.sql` (A = original on
  old, B = fix on new) gave `identical`, 24/24 rows, on the params.json test window.
- **Seen in:** master_commit_red_percent, the only one of the 217 saved queries that needs a SQL
  change. A regex scan for `) FINAL` misses this shape; check every `JOIN <name> FINAL` where
  `<name>` is a CTE, or simply run the comparison (it fails loudly).

## A2. FINAL on the right-hand table of a JOIN

- **Symptom:** `differs` with the same columns and usually the same row count, but `count`/`sum`
  columns are lower on B and averages move. Often `identical` on an old fixed window and
  `differs` on a live window, because only unmerged parts contain duplicates.
- **Cause:** in a **2-table** `FROM a [FINAL] JOIN b FINAL`, the old analyzer **ignores the
  right-hand `FINAL`**, so every unmerged ReplacingMergeTree version of a `b` row joins (an
  `in_progress` and a `completed` version of the same `workflow_run` double its jobs). The new
  analyzer applies it. With 3 or more tables in one FROM, the old analyzer's multiple-joins
  rewrite wraps each joined table in a subquery and keeps its `FINAL`, so both analyzers agree
  (live probe, workflow_job FINAL JOIN workflow_run FINAL: 2 tables old 1,609 vs new 889 rows;
  3 tables 2,426 on both, and 4,493 on old once the right `FINAL` is dropped).
  In addition, HUD's pinned profile has `analyzer_compatibility_apply_final_to_all_joined_tables
  = 1`, so on the new analyzer a `FINAL` on the left table alone also deduplicates the plain joined
  tables (not subqueries).
- **The new numbers are the correct ones.** Measured:

  | Query | Window | Old | New |
  |---|---|---|---|
  | tts_avg, sum of `count` | 2026-10-01 to 10-08 (fixed) | 145,742 | 142,981 (old +1.9%) |
  | tts_avg | last 7 days | | old about +11% |
  | tts_percentile, sum of `count` | last 6 hours | 10,170 | 8,702 (old +17%) |
  | job_duration_avg, joined rows | recent window | | old +10.9% |
  | flaky_tests/disabled_non_flaky_tests, sum of `num_green` | last 7 days (built in) | 100,220 | 95,181 (old +5.3%) |
  | trunk runs JOIN workflow_job FINAL | last 6 hours | 18,024 rows | 16,734 rows |

  Per-row averages moved by up to 28% (tts_avg). Aggregations that ignore duplicates (`max`,
  `argMax`, `uniq`, `IN`, `DISTINCT`, `GROUP BY` that collapses them) are unaffected:
  master_commit_red_jobs, viable_strict_sole_blocker and get_workflow_jobs were identical apart
  from benign array order.
- **Fix:** none is needed to migrate: opt in and report the number change in the PR. If both
  analyzers must agree during the rollout (e.g. a dashboard compared across the switch), move the
  right side into a filtered subquery with `FINAL` inside; both analyzers then return the new
  result:

  ```sql
  -- before (tts_avg)
  FROM default.workflow_job job FINAL
  JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
  -- after: both analyzers deduplicate workflow_run
  FROM default.workflow_job job FINAL
  JOIN (
      SELECT id, name, created_at, repository, head_branch, run_attempt, event
      FROM default.workflow_run FINAL
      WHERE id IN (SELECT id FROM materialized_views.workflow_run_by_created_at
                   WHERE created_at >= {startTime: DateTime64(3)}
                     AND created_at < {stopTime: DateTime64(3)})
  ) AS workflow ON workflow.id = job.run_id
  ```
  Dropping the right-hand `FINAL` instead does **not** reproduce the old numbers on the new
  analyzer (the left `FINAL` propagates, and without it the new analyzer picks versions
  arbitrarily).
- **Verify:** run on a fixed past window **and** with `--live-window` (and `--live-window 6`).
  Check `stable` (each analyzer against itself) before attributing a difference to the analyzer.
  Put `column_sums` in the PR. To confirm the cause, add `count()` next to `uniqExact(job.id)`: a
  larger `count()` on A means duplicate join rows. With the subquery fix, `--analyzers old,new
  --a-sql fix.sql --b-sql fix.sql` should be `identical` on a live window (tts_avg was), and
  `--analyzers new,new --a-sql query.sql --b-sql fix.sql` identical on a past window.
- **The 21 saved queries with a right-hand `JOIN <table> FINAL`** (`grep -rliE
  'JOIN[[:space:]]+([a-z_]+[[:space:]]*\.[[:space:]]*)?[a-z_]+([[:space:]]+(AS[[:space:]]+)?[a-z_]+)?[[:space:]]+FINAL'
  --include=query.sql torchci/clickhouse_queries`. A narrower pattern without the optional
  `default .table` spacing found only 17, which is what the bulk measurement flagged):
  - 2-table, already opted in (they show the new numbers today): job_duration_percentile,
    queued_jobs, queued_jobs_by_label, tts_percentile;
  - 2-table, not opted in, so their numbers can change on opt-in or at the 26.9 upgrade:
    commit_jobs_batch_query, commit_jobs_query, failed_workflow_jobs,
    flaky_tests/disabled_non_flaky_tests, flaky_workflows_jobs, get_workflow_jobs,
    job_duration_avg, log_captures_count, master_commit_red_jobs (absorbed by GROUP BY),
    master_commit_red_percent, ttrs_percentiles (one of its two joins), tts_avg,
    viable_strict_sole_blocker;
  - 3+ tables in that FROM, so not affected: flaky_tests/in_subprocess, hud_query (job,
    job_annotation FINAL, workflow_run subquery), master_commit_red_percent_groups,
    recent_pr_workflows_query (workflow_run, workflow_job FINAL, recent_prs).
  flaky_tests/disabled_non_flaky_tests (the /flakytest "disabled but not flaky" list, always a
  live 7-day window) was recorded as unchanged in the bulk run but differed when re-run live on
  2026-11-19: sum of `num_green` 100,220 old vs 95,181 new, 16 of 42 rows at the default
  thresholds (150/0), stable on both sides. commit_jobs_query feeds the commit page. Test every
  2-table query live.

## A3. Window function with LIMIT BY, or with ORDER BY on an unselected expression

- **Symptom:** the old analyzer fails, the new one works (`fixed_by_new`):
  `NOT_FOUND_COLUMN_IN_BLOCK` / `Not found column repo` (window + `LIMIT n BY`), or
  `UNKNOWN_IDENTIFIER: equals(phase, 'terminal')` (window + `ORDER BY` on an expression that is
  not in SELECT). Upstream issues ClickHouse#55965/#47217 and #45535; the maintainers' answer is
  "works with the analyzer".
- **Fix:** a query that uses these **must** end with `SETTINGS allow_experimental_analyzer = 1`.
  Example: test-infra#9521 adds `WINDOW attempt AS (...)` to pr_review_verdicts_for_prs, which
  already has `ORDER BY ..., phase = 'terminal' DESC ... LIMIT 1 BY pr_number`. Old-analyzer-only
  workarounds (select the expression, or move `LIMIT BY` / the window into an outer query) are not
  needed once the query opts in.
- **Related:** recent_pr_workflows_query fails on the old analyzer with `UNKNOWN_IDENTIFIER
  (47): Unknown column: log_url` (its comment says "Non experimental analyzer has problems with
  final"). Already-opted-in queries can depend on the analyzer: never remove an opt-in.
- **Verify:** `--analyzers default,new --explain` on the edited query: `plan_analyzer` must be
  `new` on side A, which proves the SETTINGS clause takes effect (it does at the end of a
  `UNION ALL` query too).

## A4. ROW_NUMBER / argMax / any over ORDER BY ties

- **Symptom:** `differs`, `stable` true on both sides, only some windows; numbers move slightly.
  master_commit_red_percent: Total identical, Broken trunk vs Flaky split moved by up to 0.9
  percentage points in some buckets.
- **Cause:** `ROW_NUMBER() OVER (PARTITION BY name, sha ORDER BY run_attempt DESC)` where
  same-named jobs from different workflows tie, so each analyzer's plan picks a different row
  deterministically. Same for `argMax(x, v)` with tied `v`, and `any()`.
- **Fix / diagnose:** in a scratch copy, add a unique tie-breaker (`ORDER BY run_attempt DESC, id
  DESC`). If both analyzers then agree, the difference is the query's own nondeterminism, not a
  migration regression. Fixing it changes today's numbers, so make it a separate, explicit change
  (or leave it and record it in the PR).

## A5. Benign nondeterminism: classify, don't fix

Confirm each by comparing the old analyzer against itself (`stable`) and by the normalised
comparison (`normalised_equal`).

| Pattern | Symptom | How to confirm | Seen in |
|---|---|---|---|
| Float `sum`/`avg` order | last-digit differences, relative error < 1e-12 | `normalised_equal: true` | crcr_l3_summary, td_ci_savings, td_push_wait |
| `groupArray` element order | array columns differ, same elements | `normalised_equal: true` (arrays sorted) | master_commit_red_jobs, viable_strict_sole_blocker, testStats3d |
| `any()` pick | a non-key column differs between rows that share a key | old vs old also differs | autorevert_significant_reverts |
| ORDER BY ties | `identical` but `row_order_equal: false` | old vs old also reorders | cost_job_per_*, duration_job_per_* (ORDER BY granularity_bucket only) |
| `now()` / `CURRENT_TIMESTAMP` in output | values grow by the seconds between runs | pin the time in a scratch copy | last_branch_push, last_successful_workflow, last_successful_jobs |
| `quantile()` / `median()` | P50 jitters in groups with more than 8192 rows | reservoir sampling; old vs old jitters | query_execution_metrics |
| `LIMIT n` over ORDER BY ties | different rows fill the last slots | old vs old also differs; drop the LIMIT and compare | vllm/job_retry_stats (179 of 181 jobs tie) |
| Live data at a `stopTime = now` edge | 1 or 2 recent rows differ on the first run only | rerun back to back | pull_workflow_duration_per_commit_detail |

Optional hardening (separate change): `arraySort(groupArray(...))`, `argMin`/`argMax` instead of
`any`, and a secondary `ORDER BY` key.

## A6. `IS NULL` after a LEFT JOIN on a non-Nullable column

- **Symptom:** none between analyzers (same on both). Rows are silently missing.
- **Cause:** with `join_use_nulls = 0`, an unmatched LEFT JOIN row gets the type default (`''`,
  `0`), not NULL, so `r.col IS NULL` on a non-Nullable column is never true.
- **Example:** autorevert_events_with_commits filters `r.revert_sha IS NULL OR (...)` ("Keep
  autoreverts even if no linked revert found"); with `= ''` it returns 47 rows instead of 41 for
  2026-10-01 to 11-19.
- **Action:** flag it in the PR and to the owner; do **not** change it silently in a migration PR.

## A7. Scalar subquery that looks correlated but is not

- **Symptom:** count columns change between any two runs, on both analyzers (`stable: false`).
- **Cause:** vllm/continuous_builds filters its scalar subqueries on
  `tupleElement(j.build, 'number') = tupleElement(build, 'number')`, meaning the outer row's
  `build`. The unqualified `build` resolves to the subquery's own table on **both** analyzers, so
  the predicate is always true and the counts cover the whole repo (about 6.58M jobs), drifting
  with live inserts.
- **Action:** a pre-existing bug, not an analyzer issue. Flag it to the owner; don't fix it in a
  migration PR (a fix changes the numbers). Look for the shape: a scalar subquery referring to an
  "outer" column whose name also exists in the inner table.

## A8. Dead and broken-regardless queries

- **Rockset SQL never converted** (`-- !!! Query is not converted to CH syntax yet`, `:param`
  placeholders, `commons.*` tables): correlation_matrix, runner_utilization,
  runner_utilization_by_activity, runner_utilization_by_repo, flaky_tests/across_jobs
  (`fetchFlakyTestsAcrossJobs()` returns `[]`). `SYNTAX_ERROR` on both analyzers.
- **No callers:** queue_times_historical_pct (last caller removed in 43fa0a65a); it runs and
  matches on both analyzers.
- **flaky_workflows_jobs** (retryBot): returns nothing on either analyzer for any realistic params
  (`flaky` never 1; `workflow_id AS next_workflow_id` resolves to the NTH_VALUE alias so it always
  equals workflow_id; TEST_FLAKE annotations stopped in 2024). It also has the A2 construct, and
  `maxAttempt = 0` fails on the old analyzer (`ILLEGAL_AGGREGATION`) but works on the new one.
- **Action:** report these in the PR (owner, evidence); don't migrate or delete them in a migration
  PR. Named-query tools (the pytorch-hud MCP server) can run any query by name, so "no callers"
  means no code callers.

---

## B. Documented incompatibilities HUD did not hit

From the ClickHouse analyzer guide and changelogs. The first five rows were reproduced on HUD's
server (old vs new, November 2026).

| Change | Symptom | Fix |
|---|---|---|
| Invalid queries are no longer rewritten into valid ones: `SELECT number ... GROUP BY toString(number)` | `NOT_AN_AGGREGATE (215)` | Make it standard: `SELECT toString(number) AS n ... GROUP BY n`, `any(col)`, or add the column to GROUP BY |
| Non-aggregate predicate in `HAVING` (the old analyzer moved it to WHERE) | `NOT_AN_AGGREGATE (215)` | Move it to `WHERE` |
| Same CTE name defined twice in one `WITH` | `MULTIPLE_EXPRESSIONS_FOR_ALIAS (179)` | Rename the CTEs |
| **`JOIN ... USING (x)` where `x` is a SELECT alias** now binds to the left table's column `x` | **Silent wrong join** (`a + 1 AS b ... USING (b)`: old joined `two`, new joins `one`) or `UNKNOWN_IDENTIFIER` | `ON t1.a + 1 = t2.b` |
| **Result column names**: aliases are no longer substituted into expression names (`1 + 1 AS x, x + 1` is `plus(plus(1, 1), 1)` on old, `plus(x, 1)` on new) | HUD reads `JSONEachRow` by key, so the TS code gets `undefined`. None of the 217 saved queries changed a column name | Alias every column the caller reads; `names_equal: false` flags it |
| Stricter scoping: an outer query cannot see aliases or tables inside a subquery/CTE | `UNKNOWN_IDENTIFIER (47)` | Select every column the outer query needs and refer to the subquery alias |
| Unqualified column present in several joined tables, or an alias that shadows a column | `AMBIGUOUS_IDENTIFIER (207)`, or the alias silently wins over the column | Qualify `t.col`; give the output alias a different name |
| Two or more JOINs: the old rewrite qualified names (`t.col`) | Outer query/client expects `t.col` but gets `col`, or the reverse | Alias explicitly; no `*` across joins |
| `a.b.c` after `ARRAY JOIN a` | Fails under `compatibility = 24.2` (it reverts `analyzer_compatibility_allow_compound_identifiers_in_unflatten_nested` to 0) | Use the ARRAY JOIN alias, or `arrayJoin(arrayZip(...))` (also friendlier to sqlfluff) |
| `USING` key supertypes: `Nullable(T)` + `T` gives `Nullable(T)` | `types_equal: false` | `CAST` if the type matters |
| Function names are case-checked (`countdistinct`) | `UNKNOWN_FUNCTION (46)` | Canonical names (`countDistinct`) |
| Types inferred before short-circuiting: `if(0, [1], 'x')` | "There is no supertype" | Make branches type-compatible |
| FINAL on a subquery | `UNSUPPORTED_METHOD` | See A1 |

**Fallback settings.** `analyzer_compatibility_*` settings restore some old behaviours under the
new analyzer. On HUD's Cloud build all seven appear in `system.settings`, and
`allow_cte_redefinition`, `allow_non_aggregate_in_having` and `join_using_top_level_identifier`
were checked to work (the OSS 26.6 tags suggest some should be missing, so check with `SELECT
name, value FROM system.settings WHERE name LIKE 'analyzer_compat%'`). Prefer fixing the SQL:
the fix is valid on every version, and a shim hides the query's intent.

**What `compatibility = 24.2` implies.** Opting in under the pin gives a hybrid: the new analyzer
with 24.2-era defaults (no correlated subqueries, no JOIN reordering, `apply_final_to_all_joined
_tables = 1`, compound identifiers after ARRAY JOIN off). Timings measured now do not predict
timings after the pin is dropped. When the pin goes, re-check A2, ARRAY JOIN compound names,
`dateTrunc` on DateTime64 (returns DateTime64 instead of DateTime), and `least`/`greatest` with
NULL arguments.

---

## C. Testing traps

- **clickhouse-client `--param_limit` / `--param_offset`** are read as the client's own `limit` /
  `offset` settings: `CANNOT_PARSE_QUOTED_STRING ... got '<digit>'` on both analyzers, even when
  the query only *declares* the param. Use HTTP (the script's default) or rename the placeholder
  in a scratch copy (the script's `--client clickhouse-client` mode does this).
- **params.json types disagree with the SQL**: `jobNames`, `workersTypes`, `workflowNames`
  declared `String` but used as `Array(String)`; `percentile` declared `Float64`, used as
  `Float32`; pr_merge_commits declares `Array(String)` for `Array(Int64)`. Trust the
  `{name: Type}` in query.sql (the script does and reports mismatches); fix params.json in the PR.
- **Empty arrays in `IN {arr}` / `has({arr}, x)` filters match nothing** (they mean "no filter"
  only when the SQL says `empty(arr) OR ...`). Copy defaults from the calling page (e.g.
  `pages/cost_analysis.tsx` option constants).
- **Value shapes:** `repo` is the bare name `pytorch` in some tables and callers
  (`ai_advisor_dispatches`, nightly_jobs_red, pr_commits, filter_forced_merge_pr), not
  `pytorch/pytorch`; vLLM tables store `https://github.com/vllm-project/vllm.git`; branches are
  `refs/heads/main` in `push.ref`; benchmark `arch` columns hold GPU/CPU model names (`NVIDIA
  A100-SXM4-40GB`), not `x86_64`; `LIKE {p}` callers pass `'%'`, and `''` matches nothing.
- **Data that stopped**: some tables are no longer populated (build_time_metrics/sccache_stats
  rows nearly stopped after May 2025, so its `HAVING count(*) > 10` is empty for any recent
  window). Find a window where data exists (`SELECT toStartOfMonth(ts), count() ...`) before
  concluding anything.
- **Placeholder or stale `tests`**: sha `abc123`, PR `12345`, repo `"<company>/<repo>"` (crcr_*),
  build number `12345` (vllm/build_failed_jobs, current builds are about 101k), vLLM job names
  that no longer exist. They prove nothing; replace them with real values from the table the
  query reads. Some params.json also have invalid types (`Array<String>`, `Datetime`).
- **Rare events need long windows** (relands: 1 to 4 per month); short-retention tables (query
  logs keep about 30 hours) need `{"from_now": N}` values.
- **`now()`-relative output** changes between any two runs: pin the time in a scratch copy before
  calling it a difference.
- **String params with newlines/tabs** must be sent escaped (`\n`); the script escapes them like
  `@clickhouse/client` does. A raw newline on the CLI gives `BAD_QUERY_PARAMETER`.
- **Compare sorted rows and row order** separately (the script reports both); a sorted-hash match
  can hide an ORDER BY change, a positional diff misaligns rows. Diff by key columns when needed.
- **Never call two empty results "identical"** (`identical_empty` means unverified). Every empty
  result in our triage came from bad params, not from the SQL.
- **When the final output is empty or identical but you suspect a difference**, run an
  intermediate CTE (`SELECT * FROM latest_attempts`) on both analyzers; in flaky_workflows_jobs
  the difference was only visible at a CTE.
- **Dynamic callers**: `pages/metrics.tsx` builds `workflow_duration_avg`, `tts_avg` and
  `job_duration_avg` with `.replace("percentile", "avg")` (the "avg" percentile option), so a
  plain grep for those names finds nothing. Grep for name fragments and `/api/clickhouse/${`.
