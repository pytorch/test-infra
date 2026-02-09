# iOS App Progress Report

## Summary
- Total pages compared: 28
- **Exceeds/Strong (8+/10):** 6 pages
- **Good but Incomplete (6-8/10):** 9 pages
- **Needs Work (4-6/10):** 10 pages
- **Critical Issues:** 3 pages with blocking bugs or wrong data sources

## Critical Issues (fix immediately)

### Page 6: Reliability -- Rating: 4/10
- **Hardcoded `totalJobs: 10000`** -- all absolute job counts are fabricated, not real data
- **Wrong ClickHouse query** -- uses `master_commit_red_percent_groups` (averaged percentages) instead of web's `master_commit_red_jobs` (per-job commit-level data); failure category breakdown (Broken Trunk/Flaky/Infra) is always near-zero
- **Only 4 of 9 workflow names fetched** -- Secondary and Unstable filter tabs return zero results
- Action: Switch to `master_commit_red_jobs` query, pass all 9 workflows, remove hardcoded totalJobs

### Page 11: vLLM Metrics -- Rating: PARTIAL
- **CRITICAL: Wrong pipeline name** -- iOS sends `"vllm-ci"` but web uses `"CI"`; all build-related queries likely return wrong/empty data
- **2 entire tabs missing** (Utilization & Cost, CI Builds) and 7 of 14 API queries not called
- **Zero test coverage** for ~400 lines of data processing logic
- Action: Fix pipeline name to `"CI"`, fix repo URL (add `.git`), add tests

### Page 21: Failed Jobs -- Rating: 4/10
- **Annotations are local-only** -- not persisted to backend via POST; changes lost on restart and invisible to team
- **No log viewer** -- only 2-line failure preview; engineers cannot diagnose failures without leaving the app
- Missing: failure search, reproduction command, disable test, mark unstable, revert info copy
- Action: Implement annotation POST to backend, add basic log viewing

## Needs Work (significant gaps vs web)

### Page 1: HUD Grid -- NEEDS WORK
- Missing: grouped view, auto-refresh, autorevert awareness, inline log viewer, unstable issues API, hide-unstable/hide-green/hide-non-viable-strict filters
- CommitRowView appears to be dead/unused code
- 53 tests across 3 files; solid data model but feature gaps prevent full triage workflow

### Page 2: Commit Detail -- NEEDS WORK (102 tests)
- Missing: inline log viewer (critical for debugging), unstable issue integration, auto-refresh, autorevert API (uses title heuristic instead)
- `isFailure` includes cancelled but `failedJobs` excludes it -- inconsistent counts
- Missing power-user features: workflow dispatch, annotations, artifacts, disable test

### Page 3: PR Detail -- NEEDS WORK (0 tests)
- **PRResponse model expects fields API never returns** (state, author, branch info) -- UI sections permanently empty
- **Zero test coverage** for ViewModel with complex grouping/filtering logic
- Missing: inline log viewer, unstable issue cross-referencing, auto-refresh

### Page 4: Metrics Dashboard -- NEEDS WORK (54 tests)
- Six major web features entirely absent: queued jobs table, individual jobs in queue, failed jobs log classifications, job TTS tables, job duration tables, workflow load chart
- Stacked bar chart reduced to single-series line chart; queue time data flattened
- Good iOS additions: health banner, trends, navigation section

### Page 16: Benchmark Dashboard -- PARTIAL
- **Wrong ClickHouse query** -- queries `oss_ci_benchmark_llms` for all benchmarks; web uses `compilers_benchmark_performance` for compiler pages
- Only 3 of 8 V3 benchmark ID mappings; no two-commit comparison; no device/mode/dtype filters
- Good iOS additions: statistical analysis, distribution histogram, trend insights

### Page 17: Compiler Benchmarks -- Rating: 5/10 (103 tests)
- **No left/right commit comparison** -- the web page's primary feature for detecting regressions
- **Regression benchmark ID mismatch** -- `compiler_precompute` (web) vs `compiler_regression` (iOS)
- Missing: per-suite time-series graphs, branch selection, several device options

### Page 18: LLM Benchmarks -- Rating: ~5/10 (42 tests)
- No commit-diff comparison, no multi-repo comparison mode, no configurable time range
- Metrics collapsed into 4 keyword-based categories vs individual metrics on web
- Missing: profiling artifacts, CSV export, geomean aggregation

### Page 19: TorchAO Benchmarks -- Parity: LOW (~25-30%)
- **CRITICAL: Repo mismatch** -- iOS sends `pytorch/ao`, web sends `pytorch/benchmark`
- **Arithmetic mean used instead of geometric mean** for speedup aggregation (mathematically incorrect)
- No commit diff comparison, no time-series graphs, no compilation time metric
- 39 tests; suite filtering is fragile (string-contains on model names)

### Page 24: Utilization -- Rating: ~30-35%
- **Job detail page entirely missing** despite models and API endpoint being defined (dead code)
- Missing `includes_stats=true` parameter on workflow detail API call
- No GPU utilization display; **zero test coverage**
- Action: Fix `includes_stats=true`, implement job detail page, add GPU metrics, write tests

## Good but Incomplete (minor gaps)

### Page 5: KPIs -- Rating: 7/10 (39 tests)
- All 10 KPIs present with well-designed card UI. TTRS only shows p50 (web shows p25/p50/p75/p90)
- 4 KPIs collapse grouped series into single aggregate. Parameter mismatches on disabled tests and strict_lag
- All-or-nothing error handling (one failed call breaks entire page)

### Page 7: Autorevert Metrics -- Rating: ~75% (33 tests)
- Core metrics faithful; health gauges are a nice iOS addition
- Missing: workflow filter (hardcoded 4 workflows), GitHub deep links, max_red_streak display
- Chart split into two separate visualizations loses dual-axis correlation

### Page 8: TTS (Time to Signal) -- STRONG with trade-offs (53 tests)
- iOS dramatically exceeds web in visualization (distribution bands, percentile gauges, bottleneck identification)
- Trade-off: sacrifices multi-job comparison (web's core use case) for aggregate views
- Hardcoded repo/branch, missing avg/P95/P100 modes, 4x API calls per load

### Page 9: Build Time -- Rating: 6/10 (0 tests) / Queue Time -- Rating: 7/10 (40 tests)
- Build Time: **zero test coverage**, redundant API call, percentile chart permanently shows "No data" (stubbed), missing sccache stats
- Queue Time: strong mobile adaptation with excellent tests, but uses different API query than web; missing heatmap/histogram

### Page 10: Cost Analysis -- Rating: ~40% parity (40 tests)
- Missing duration/hours view, 5 group-by categories, all user-configurable filters (hardcoded)
- No granularity control, no text/regex filter, no data table/CSV export
- Good iOS additions: period comparison, total cost summary, top contributors ranking

### Page 13: Test Info -- Rating: 7/10 (50 tests)
- **3dStats API is broken server-side** (returns `[]`) -- affects both web and iOS; stats/trend section non-functional
- Missing `file` parameter on failures endpoint; no log viewer
- Strong iOS additions: status badge, pass rate stats, branch filter, copy actions

### Page 14: Disabled Tests -- GOOD (63 tests) / File Report -- PARTIAL (30 tests)
- Disabled Tests: exceeds web in several UX areas (stat cards, platform badges, group-by-suite). Missing: issue state filter, label filter
- File Report: useful summary but missing commit comparison, graphs, status changes, regex filters

### Page 20: Regression Reports -- Rating: 5/10
- Individual report view covers essential data with iOS extras (severity indicators, sort, change%)
- **No time series charts** (critical for regression analysis), no reports listing page, no policy viewer
- Good model/test coverage but missing the most important analytical visualization

### Page 22: Failure Analysis -- Rating: 6/10 (28 tests)
- Good UX reimagining with summary cards, distribution bars, detail sheets
- Missing: inline log viewer (vastly simplified), job action links (disable test, reproduction command, "more like this")
- Missing: fuzzy search toggle, separate failure captures input

## Strong / Exceeds Web

### Page 12: Test Search -- EXCEEDS (42 tests)
- All web functionality plus: tabbed interface, disabled tests tab, filter chips, recent search history, welcome/empty states, infinite scroll
- Minor: missing `per_page` parameter (relies on server default), `invoking_file` not displayed

### Page 23: Runners -- PRODUCTION READY (42 tests)
- Faithful port with significant enhancements: status filter pills, utilization bars, 30-second auto-refresh, OS icons, accessibility
- All data fields matched; no blocking issues found

### Page 25: Nightlies -- EXCELLENT (40 tests)
- All 10 web panels faithfully reproduced with matching API calls
- iOS additions: overall health summary card, color-coded severity, platform icons, expandable job lists
- Minor: missing `repo` param on one query, no auto-refresh, no chart interactivity

### Page 26: Job Cancellation -- PARITY (1 test) / Claude Billing -- STRONG (30 tests)
- Job Cancellation: identical Grafana WebView embed, pragmatic approach
- Claude Billing: fully native implementation far exceeding the web's Grafana embed. Known gap: cost-by-model always empty, token breakdown shows "--"

### Page 27: TorchAgent (Flambeau) -- GOOD (200 tests)
- All 7 API endpoints matched; streaming parsing robust; 200 tests is exceptional coverage
- Superior: streaming indicator, chat bubble design, welcome screen with example prompts
- Missing: Grafana dashboard embeds, TodoList rendering, ClickHouse deep-links, auto-refresh of history

### Page 28: Settings + Auth + About -- iOS-ONLY FEATURE (108 tests)
- Significant expansion beyond web: theme picker, notification settings, cache management, about screen
- Notification settings is standout: threshold gauge, preview system, branch/repo monitoring
- Gap: LoginView has zero test coverage

## Needs User Input

1. **Page 19 (TorchAO):** Repo parameter -- should it be `pytorch/ao` or `pytorch/benchmark`? Web uses `pytorch/benchmark` but this may be outdated.
2. **Page 11 (vLLM):** Pipeline name -- is `"CI"` correct for the vLLM pipeline, or has it changed to `"vllm-ci"`? Need to verify against actual Buildkite configuration.
3. **Page 13 (Test Info):** The `3dStats` API is broken server-side (returns `[]` on line 23). Should someone fix this backend endpoint, or should the iOS app work around it?
4. **Page 16 (Benchmark Dashboard):** Should the iOS app use `oss_ci_benchmark_llms` for all benchmarks or implement per-type query routing (`compilers_benchmark_performance`, `torchao_query`, etc.)?
5. **Page 1 (HUD):** Should CommitRowView be removed (dead code) or wired in as an alternative view mode?
6. **Page 3 (PR Detail):** Should the server API be extended to return `state`, `author`, `branch` fields, or should the iOS model/UI be trimmed to match what the API actually returns?
7. **Pages 1, 2, 3, 4 (HUD/Commit/PR/Metrics):** Should auto-refresh be implemented? If so, what interval? Web uses 60 seconds for HUD/commit/PR, 5 minutes for KPIs.
8. **Page 21 (Failed Jobs):** Should annotations POST to the backend be implemented, making them visible to the team? This requires authentication.

## Test Coverage Summary

| Page | Name | Tests | Coverage Rating |
|------|------|-------|-----------------|
| 1 | HUD Grid | 53 | Good |
| 2 | Commit Detail + Job Detail | 102 | Excellent |
| 3 | PR Detail | 0 | **None** |
| 4 | Metrics Dashboard | 54 | Good |
| 5 | KPIs | 39 | Good |
| 6 | Reliability | 45 | Good (but tests validate broken logic) |
| 7 | Autorevert Metrics | 33 | Good |
| 8 | TTS (Time to Signal) | 53 | Excellent |
| 9 | Build Time | 0 | **None** |
| 9 | Queue Time | 40 | Good |
| 10 | Cost Analysis | 40 | Good |
| 11 | vLLM Metrics | 0 | **None** |
| 12 | Test Search | 42 | Excellent |
| 13 | Test Info | 50 | Excellent |
| 14 | Disabled Tests | 63 | Excellent |
| 14 | File Report | 30 | Good |
| 15 | Benchmark List | 55 | Excellent |
| 16 | Benchmark Dashboard | 25 | Good |
| 17 | Compiler Benchmarks | 68 | Excellent |
| 17 | Compiler Regression | 35 | Good |
| 18 | LLM Benchmarks | 42 | Good |
| 19 | TorchAO Benchmarks | 39 | Good |
| 20 | Regression Reports | ~40 | Good (shared across files) |
| 21 | Failed Jobs | 45 | Good |
| 22 | Failure Analysis | 28 | Good |
| 23 | Runners | 42 | Excellent |
| 24 | Utilization | 0 | **None** |
| 25 | Nightlies | 40 | Excellent |
| 26 | Job Cancellation | 1 | Minimal (appropriate) |
| 26 | Claude Billing | 30 | Excellent |
| 27 | TorchAgent | 200 | Exceptional |
| 28 | Settings/Auth/About | 108 | Excellent (except LoginView: 0) |
| **Total** | | **~1,442** | |

Pages with **zero tests**: PR Detail (3), Build Time (9), vLLM Metrics (11), Utilization (24)

## API Endpoint Audit

| Page | Endpoint | Issue |
|------|----------|-------|
| 6 | `master_commit_red_percent_groups` | **Wrong query** -- should use `master_commit_red_jobs` for per-workflow tables |
| 6 | `master_commit_red_percent_groups` | Only 4 of 9 workflow names passed |
| 11 | `vllm/ci_reliability` + 4 others | **Wrong pipeline name** `"vllm-ci"` instead of `"CI"` |
| 11 | `vllm/ci_run_duration` | Sends extra `jobGroups` parameter not sent by web |
| 13 | `/api/flaky-tests/failures` | **Missing `file` parameter** -- may return wrong test's failures |
| 13 | `/api/flaky-tests/3dStats` | **Broken server-side** -- returns `[]` (both web and iOS) |
| 16 | `oss_ci_benchmark_llms` | **Wrong query for compiler benchmarks** -- should use `compilers_benchmark_performance` |
| 17 | `list_regression_summary_reports` | **Wrong report_id** -- `"compiler_regression"` vs web's `"compiler_precompute"` |
| 19 | `torchao_query` | **Wrong repo** -- `"pytorch/ao"` vs web's `"pytorch/benchmark"` |
| 19 | `torchao_query` | Arithmetic mean used instead of geometric mean for speedup |
| 21 | `/api/job_annotation/{repo}/{annotation}` | **POST not implemented** -- annotations are local-only |
| 24 | `/api/list_utilization_metadata_info/{id}` | **Missing `includes_stats=true`** parameter |
| 3 | `/api/{owner}/{repo}/pull/{prNumber}` | iOS model expects fields (state, author, branches) not returned by API |
| 5 | `disabled_test_historical` | iOS sends different params (`label`, `platform`, `triaged`) vs web (`repo`) |
| 9 | `queue_times_historical` | iOS uses different query than web's `queue_time_analysis/queue_time_query` |
| 25 | `nightly_jobs_red_by_name` | Missing `repo` parameter (minor) |
