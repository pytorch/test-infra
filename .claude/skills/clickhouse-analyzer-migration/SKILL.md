---
name: clickhouse-analyzer-migration
description: Playbook for migrating PyTorch HUD's ClickHouse queries (torchci/clickhouse_queries and inline SQL in torchci) to ClickHouse's new query analyzer, a batch at a time, with old-vs-new result comparison, timing and PR evidence. Use when opting HUD queries into the analyzer (`SETTINGS allow_experimental_analyzer = 1`, `enable_analyzer`), preparing for the ClickHouse 26.9 upgrade that makes the analyzer mandatory, comparing a query on the old and new analyzer, or debugging analyzer errors such as UNKNOWN_IDENTIFIER, UNSUPPORTED_METHOD ("FINAL ... not supported for subquery"), NOT_AN_AGGREGATE, AMBIGUOUS_IDENTIFIER, MULTIPLE_EXPRESSIONS_FOR_ALIAS or "Not found column" with window functions and LIMIT BY.
---

# Migrating HUD ClickHouse queries to the new analyzer

Load the `pytorch-clickhouse` skill first (repo CLAUDE.md requires it for any torchci query
work); it covers the MCP tools, data model and performance rules. This skill adds the migration
procedure, `scripts/compare_analyzers.py` (old vs new comparison), and
`references/patterns.md` (what breaks or changes, with before/after SQL). Read patterns.md
before classifying any difference.

## Why, and the deadline

- HUD's ClickHouse Cloud service runs 26.6. The `default` settings profile pins `compatibility =
  24.2`, which turns the analyzer off (`enable_analyzer = 0`) for `hud_user`.
  `torchci/lib/clickhouse.ts` does not override it, so every query runs on the old analyzer
  unless it opts in.
- **26.9 makes the analyzer mandatory** (`compatibility` no longer reverts it) and **26.10 removes
  the old code** (upstream CHANGELOG, #118629 and #120311). A Cloud upgrade past 26.9 moves every
  query at once.
- A query opts in by ending with `SETTINGS allow_experimental_analyzer = 1`. That is the
  incremental path: each opt-in is tested now, instead of all queries changing on upgrade day.
  The setting stays accepted after 26.9 (a no-op from 26.10), so leave it in place. **Never
  remove an existing opt-in**: some queries fail on the old analyzer (recent_pr_workflows_query
  gets `UNKNOWN_IDENTIFIER: log_url`).
- Opting in under the pin gives the new analyzer with 24.2-era planner defaults (patterns.md,
  end of B). That is the state we test and ship; re-check when the pin is dropped.

## Status (measured 2026-11-19, all 217 saved queries: 177 top-level, 40 nested)

| Verdict | Count | Queries / action |
|---|---|---|
| works_unchanged | 191 | Opt in after the per-query checks below |
| benign_nondeterminism | 11 | Opt in; differences also occur between two old runs (patterns.md A5) |
| already_opted_in | 7 | job_duration_percentile, queued_jobs, queued_jobs_aggregate, queued_jobs_by_label, recent_pr_workflows_query, td_trunk_breakages, tts_percentile. Leave alone |
| needs_migration | 1 | master_commit_red_percent: drop the FINAL on the `pushes` CTE (A1) |
| broken_regardless | 1 | flaky_workflows_jobs: returns nothing on either analyzer (A8). Report, don't migrate |
| unused | 6 | correlation_matrix, runner_utilization, runner_utilization_by_activity, runner_utilization_by_repo, flaky_tests/across_jobs (unconverted Rockset SQL), queue_times_historical_pct (no callers). Report, don't migrate |

- **Numbers change** in the 2-table right-hand `JOIN t FINAL` queries listed in patterns.md A2
  (the old analyzer double counts unmerged rows; new numbers are correct). Test them on a live
  window; most were only measured on fixed past windows, where the difference hides.
- Result column names: no differences in any of the 217 queries.
- **Not measured:** inline SQL in torchci (see "Inline SQL" below).
- `tts_avg`, `job_duration_avg` and `workflow_duration_avg` look unused to grep but are called
  from `pages/metrics.tsx` via `queryName.replace("percentile", "avg")`.

## What "migrated" means for one query

1. It runs on the new analyzer.
2. On fixed params **that return rows**, it returns the same rows as on the old analyzer (same
   header, same sorted rows, and row order compared), or every difference is classified with
   numbers: benign (A5) or old analyzer wrong (A2), recorded for the PR.
3. `params.json` has at least one `tests` entry with a fixed past window that returns rows, and
   its `params` types match the `{name: Type}` placeholders in the SQL.
4. The SQL ends with `SETTINGS allow_experimental_analyzer = 1`, merged into an existing
   `SETTINGS` clause if there is one (`SETTINGS max_execution_time = 60,
   allow_experimental_analyzer = 1`), before any trailing `;`. It also works after `UNION ALL`.
5. EXPLAIN and before/after timing over alternating runs are recorded, per CLAUDE.md.

## Per-query workflow

```bash
S=.claude/skills/clickhouse-analyzer-migration/scripts/compare_analyzers.py
# Credentials: the script reads CLICKHOUSE_HUD_USER_* from the environment or torchci/.env.local.
# In a git worktree .env.local only exists in the main checkout, so load it from there:
( set -a; source <main-checkout>/torchci/.env.local; set +a; python3 $S tts_avg --params '{...}' )
# If TLS fails: add --no-proxy (corporate proxy) and --cafile /etc/ssl/cert.pem, or --client clickhouse-client
```

1. **Find callers and real params.** `git grep -n '<name>' -- torchci` plus name fragments and
   `/api/clickhouse/${` (names are built dynamically). Copy the values the page or bot really
   sends (options constants, defaults). No callers anywhere: report it as dead, don't migrate.
2. **Compare on a fixed past window.** `python3 $S <name>` uses `tests[0]`; `--test-index N` or
   `--params '{"startTime": "2026-10-01T00:00:00.000", ...}'` (params.json format, `{"from_now":
   -7}` allowed). `identical_empty` is unverified: find params that return rows (patterns.md C).
3. **Also run live** if the SQL has a right-hand `JOIN t FINAL` (the script notes it) or reads
   recent data: `--live-window` (same length, ending now) and `--live-window 6` (last 6 hours).
4. **Classify** the verdict with patterns.md: `breaks_on_new` (A1, B), `differs` with
   `stable: false` on a side (data churn or the query's own nondeterminism, A4/A5),
   `normalised_equal: true` (benign), or a stable count drop on B (A2: record `column_sums`).
5. **Fix only what the analyzer needs**, minimally. Don't fold in unrelated bug fixes (A4, A6, A7
   findings go in the PR as notes for the owner).
6. **Re-verify** the edited working tree against the baseline:
   ```bash
   git show origin/main:torchci/clickhouse_queries/<name>/query.sql > /tmp/<name>.base.sql
   python3 $S <name> --a-sql /tmp/<name>.base.sql --repeat 5 --explain   # A: original on old, B: working tree on new
   python3 $S <name> --analyzers default,new --explain                   # as HUD runs it: plan_analyzer A must be "new"
   ```
   Repeat with `--live-window` when step 3 applied. The pytorch-hud / clickhouse-mcp named-query
   tools run the deployed SQL, not your working tree. Read `A.explain.txt`/`B.explain.txt` for
   pruning (`Granules: kept/total`). Timing is recorded, not assumed: the new analyzer can be much
   faster (flaky_tests/in_subprocess 20 s to 9 s on 6 h, 149 s to 84 s on 100 h) or a little
   slower. If it is clearly slower, try rewrites per CLAUDE.md, comparing each one against the
   migrated query on the new analyzer (`--analyzers new,new --a-sql migrated.sql --repeat 5`);
   keep a rewrite only if rows are identical and it beats the noise.
7. **params.json:** add a `tests` entry with a fixed past window that returns rows (the values
   from step 2), fix types to match the SQL, replace placeholder tests (`abc123`).
8. **Lint:** `lintrunner torchci/clickhouse_queries/<name>/query.sql
   torchci/clickhouse_queries/<name>/params.json` (see torchci/README.md "Linting a query"), and
   run any jest test that reads the SQL (`git grep -l '<name>' torchci/test`, then
   `cd torchci && yarn test <file>`).
9. **PR description:** the evidence table below, user-visible number changes called out first,
   dead/broken queries and pre-existing bugs listed separately.

## Inline SQL in torchci

About 55 `queryClickhouse(...)` call sites in 31 files embed SQL in TypeScript. They were not
part of the measurement. List them with:

```bash
git grep -n "queryClickhouse(" -- torchci ':!torchci/test' ':!torchci/scripts' \
  ':!torchci/lib/clickhouse.ts' ':!torchci/lib/api/tests/clickhouse.ts'
```

(Don't exclude `*test*`: `torchci/lib/api/tests/` is the production test-hub API, 15 files.)
For each: copy the SQL into a scratch `.sql` file, rendering any `${...}` interpolation with the
values the code uses (one file per branch if the SQL is assembled conditionally), keep the
`{name: Type}` placeholders, and run `python3 $S /tmp/scratch/<file>.sql --params '{...}'` with
the call's params. To opt in, append `SETTINGS allow_experimental_analyzer = 1` to the SQL text
(preferred: it stays with the query), or pass `{ allow_experimental_analyzer: 1 }` as the
`settings` argument of `queryClickhouse(query, params, query_id?, useQueryCache?, settings?)`
(torchci/lib/clickhouse.ts and the test-hub wrapper in torchci/lib/api/tests/clickhouse.ts).
Verify the text form with `--analyzers default,new --explain` on the scratch file.

## Batching

- Pick a subset by page or owner, about 10 queries per PR, one agent per batch: e.g. /metrics
  (tts_*, job_duration_*, workflow_duration_*, queue times), HUD grid and commit page (hud_query,
  commit_jobs_query, commit_jobs_batch_query, get_workflow_jobs), Dr.CI and bots, autorevert,
  flaky tests, benchmarks, vllm/*, crcr_*, one PR per inline-SQL area.
- Keep number-changing queries (A2) in their own PR so reviewers see the change;
  master_commit_red_percent's FINAL fix can be its own small PR.
- Each agent gets: the query list, this skill, and the instruction to stop and report (not
  guess) when a query has no callers, no data, or a difference it cannot classify.

## Production DB etiquette

- Read-only `hud_user` credentials only; never the `*_WRITE_*` ones. Never print, echo or paste
  credentials or `.env.local` contents.
- At most 2 queries running at once across all agents. The script runs one query at a time, so
  at most 2 agents run it concurrently.
- Keep `--max-execution-time` (default 120 s); use `--repeat` of 3 to 5, fewer for queries over
  30 s. Don't widen windows beyond what callers use, except to find rare events.

## Script reference

`compare_analyzers.py QUERY|FILE.sql ... [options]` (stdlib only; `-h` for all flags). Side A =
session default (old analyzer) with any SQL opt-in set to 0; side B = `allow_experimental_analyzer
= 1`. `--analyzers default,new` runs side A exactly as HUD would. Per query it prints and writes
to `/tmp/analyzer-compare/<name>/summary.json`: `verdict` (identical, identical_empty,
differs, breaks_on_new, fails_both, fixed_by_new), `rows`, `names_equal`, `types_equal`,
`row_order_equal`, sorted-row `hash`, `errors` and `hint`; for `differs` also
`normalised_equal` (floats rounded to `--sig` digits, arrays sorted), `only_in_A/B`, `stable`
(each side against its own rerun) and `column_sums` of numeric columns that moved; `secs` per
run (server time); `plan_analyzer` with `--explain`; `notes` (params.json type mismatches,
missing tests, right-hand JOIN FINAL, now() use). Raw outputs (`A.1.jsonl`, ...) are
JSONCompactEachRowWithNamesAndTypes: line 1 names, line 2 types, then rows. Exit code 0 only if
every query is `identical`.

## PR evidence table

Example row (tts_avg, measured 2026-11-19):

| Query | Caller (page) | Params / window | Rows old / new | Verdict | Difference and class | Numbers moved | Median s old → new (n) |
|---|---|---|---|---|---|---|---|
| tts_avg | /metrics (avg) | main, 2026-10-01..08; live 7 d | 645 / 645 | differs, stable | A2, old double counts | count 145,742 → 142,981 | 0.33 → 0.44 (2) |

Add one line per window tested, then the lists: queries opted in unchanged, number changes (with
why the new value is right), dead/broken queries, pre-existing bugs found, params.json fixes.
