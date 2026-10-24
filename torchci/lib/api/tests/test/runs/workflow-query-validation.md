# Run workflow metadata: SQL validation

The event and pull-request metadata section below validates the current workflow
lookup with checked-in SQL, results and a replay script. Earlier sections are
historical implementation measurements whose raw artifacts were not retained.
For the other queries and current defaults, see
[Tests API SQL validation](../../query-validation.md).

## Event and pull-request metadata (2026-10-24)

The lookup reads the retained workflow's `event`, repository ID and recorded
`pull_requests` associations, including each PR's destination/base repository ID.
The response mapper selects the unique PR whose base repository ID matches the
workflow repository ID, then converts its API URL into a browser URL and exposes
`pull_request: { number, url }`. Duplicate records of the same PR collapse into
one object. Missing metadata, no matching PR or multiple distinct matching PRs
produce `pull_request: null`. Repository IDs are decimal strings to preserve
Int64 precision. The source/head repository and event do not control this filter:
a push can be associated with a valid PR in the same repository. Both table reads
retain `FINAL`, the latest-row ordering and every deterministic tie breaker.

The singular public response is assembled in the mapper. The SQL still returns
the recorded association array internally; its statement and the measurements
below are unchanged by the response-shape change.

The [evidence bundle](workflow-query-validation.json) contains the generated
functional baseline and working-tree SQL, bound parameters, complete
result rows, EXPLAIN plans, all timing samples and full-row equality digests.
The baseline is the previous query plus only the workflow repository ID and PR
base repository ID projections, using an explicit array mapping to stringify
the base IDs. The working-tree candidate lets the existing tuple cast perform
that conversion. Both versions now include the query-local
`SETTINGS output_format_json_named_tuples_as_objects = 1`, and these measurements
were repeated with that setting. The shared metadata builder used for page
selection is unchanged. Run from `torchci/`:

```sh
node scripts/validateRunWorkflowQuery.cjs
node scripts/validateRunWorkflowQuery.cjs --live > workflow-validation.json
```

Offline mode checks the current SQL and bindings against the evidence. Live mode
uses the normal `CLICKHOUSE_HUD_USER_*` environment variables or `.env.local`,
disables query caching and runs both variants sequentially with a 90-second server
limit. JSON settings match production, including numeric PR numbers and named
tuples serialized as `{number, url, base_repository_id}` objects. Both repository
IDs are strings even with production's numeric Int64 JSON setting. Live data can
change; a differing or empty result fails validation rather than being ignored.

The replay also executes the generated query with the opposing client setting
`output_format_json_named_tuples_as_objects: 0`. The query-local setting wins:
every nonempty PR tuple is still an object, and all eleven complete rows match
the ordinary executions exactly. The evidence records this extra execution and
its equality digest under `named_tuple_override`.

The fixture contains ten distinct real jobs, one repeated ID, zero and the two
Int64 boundary IDs. All 16 executions returned the same eleven complete rows, after
sorting by job ID; both boundary IDs were absent. It covers:

- Job `119697295038`: event `pull_request`, with PR
  `https://api.github.com/repos/pytorch/pytorch/pulls/115316`. The workflow and
  PR base repository IDs both equal `65600975`, so the association is retained.
- Jobs `119688453924` and `119692775894`: events `pull_request` and
  `pull_request_target`, respectively, with empty recorded association arrays.
- Job `120790198655`, workflow `40065629499`: event `push` in repository
  `65600975`, with seven PR associations whose base repository IDs are
  `829850672`, `843886882`, `727000293`, `778669783`, `664864358`, `638032568`
  and `501340649`. The mapper excludes all seven, returning `null`. The raw SQL
  evidence keeps these IDs, so the mapping decision is independently inspectable.
- Job `119695966254`: another main push with the same seven unrelated fork PR
  associations. A nonempty raw array does not imply a PR event or an association
  with the workflow's repository.
- Job `119692503545`: a `ciflow/trunk/201544` push with no recorded association;
  this lookup does not infer PRs from branch names.
- Jobs `115463861620` and `115564887788`: different attempts of one workflow,
  each retaining its own job URL while sharing the latest workflow metadata.
- Job zero: no workflow association, a zero availability flag, null repository
  ID/event and an empty raw array, mapped to `pull_request: null`.

A live `getRun` call for test run `1691e322-bbd1-4c55-847d-49ec0dcf1b40`
passed response-schema validation and returned job `120790198655` with
`event: "push"` and `pull_request: null`. Live enrichment of job `119697295038`
retained PR `115316` with browser URL
`https://github.com/pytorch/pytorch/pull/115316`.

Live `SHOW CREATE TABLE` confirmed the `SharedReplacingMergeTree` keys documented
below. `pull_requests` is an array of named tuples containing `number Int64`,
`url String` and nested base/head metadata. `repository.id` is `Int64`, and
`pull_requests.base.repo.id` is `Array(Int64)`. Both compared queries read only
the required subcolumns, then zip them into named tuples. These arrays come from
the same stored tuple array, so their ordering and lengths align. The mapper
filters the response; no SQL filtering, deduplication, joins, approximate
functions or time bounds were added.

`EXPLAIN indexes=1` and `EXPLAIN PIPELINE` succeeded for both variants. Each kept
44 of 32,144 job granules and eleven of 14,660 workflow granules. Eight alternating
pairs reversed execution order on each pair:

| Version                    | Median server seconds | Rows read | Bytes read |
| -------------------------- | --------------------: | --------: | ---------: |
| Explicit string conversion |                 0.051 |   386,836 | 28,127,336 |
| Tuple cast in working tree |                 0.051 |   386,836 | 28,127,336 |

Reads are identical and the latency change is within run-to-run noise; no
performance improvement is claimed. Optimization stopped there. The tuple cast
is retained because it provides the same exact conversion with less code and no
extra array mapping. These measurements supersede the earlier PR-projection
measurements for this query.

## Original workflow lookup (2026-10-22)

Validated on 2026-10-22 against live, read-only ClickHouse. The SQL was generated
from the working-tree `buildRunWorkflowQuery`, executed with bound parameters,
and measured with the query cache disabled. Run selection, filters, sorting and
pagination are unchanged; this lookup enriches only the returned page's jobs.

## Sources and deduplication

The lookup uses `default.workflow_job.run_id` and `html_url`, then the matching
`default.workflow_run.path` and `head_sha`. `github_workflow_job_url` contains the
job's recorded HTML URL. The commit SHA still comes from the workflow, whose
head SHA can differ from the job's merge-commit SHA. Empty metadata strings and
a zero workflow association become `null`; a missing workflow does not remove
the job's known workflow run ID or job URL.

Live DDL confirms that both tables use `SharedReplacingMergeTree`, with ordering
keys `(id, run_id, dynamoKey)` for jobs and `(id, dynamoKey)` for workflows.
`FINAL` retains different `dynamoKey` values, so the query additionally chooses
one row per GitHub ID using descending `_inserted_at` and deterministic tie
breakers. This prevents metadata duplicates from multiplying run results.

Workflow attempts share an ID and can replace the previous attempt's metadata.
The query therefore joins by workflow ID. The fixture includes attempt-1 job
`115463861620` and attempt-2 job `115564887788`, both attached to workflow
`38445828306`. Its retained workflow row has `run_attempt = 2`; both jobs correctly
receive `.github/workflows/trunk.yml`, commit
`8caf0da8a5061291f1186f976bdbf7f8eda89ab1`, and their individual job URLs:

- `https://github.com/pytorch/pytorch/actions/runs/38445828306/job/115463861620`
- `https://github.com/pytorch/pytorch/actions/runs/38445828306/job/115564887788`

## Fixed fixture and equivalence

The input contains 100 job IDs: 96 distinct real jobs from the commit above, one
repeated real job, and the decimal strings `-9223372036854775808`, `0`, and
`9223372036854775807`. Binding keeps the IDs lossless and deduplicates the input
to 99 strings. The two Int64 boundary IDs are absent. Job ID zero exists in the
source with many distinct `dynamoKey` values and a zero workflow association;
its selected result contains four null metadata values.

Every execution returned the same complete 97 rows: 96 real jobs with metadata
and the zero-ID row. All 16 alternating baseline/candidate executions matched
after sorting full JSON rows by job ID. An independent oracle read the scoped
`FINAL` job and workflow records separately, selected their latest rows in
Python, and joined them there. All five output columns matched exactly. The
oracle read 117,535 job rows (including the many zero-ID records) and 42 workflow
rows, demonstrating why one-row-per-ID selection is needed in addition to
`FINAL`. A separate read-only fixture retained these two real jobs while
emptying the workflow side of the join. Both still returned their stored job
URLs and workflow IDs, with `workflow_path` and `commit_sha` set to `null`.
This missing-workflow fixture is recorded separately from production SQL.

No approximate functions, arbitrary time ranges, table mutations, or deployed
named queries were used.

## Plans and measured optimization

The functional baseline is the previous query with only the requested URL
source and name changed, including removing the unused workflow URL projection.
It filters jobs by the requested IDs and workflows by the resulting workflow
IDs. `EXPLAIN indexes=1` and `EXPLAIN PIPELINE`
succeeded for that SQL and a candidate moving these exact identity predicates
from `WHERE` to `PREWHERE`. Both variants used the ID primary keys: the baseline
kept 43 of 32,075 job granules and 7 of 14,621 workflow granules. The candidate
kept the same granules; background ingestion slightly changed the totals.

Measurements alternate baseline/candidate for four pairs, then
candidate/baseline for four pairs. These are server elapsed seconds, including
all samples:

| Variant              | Server seconds                                         | Median | Rows read | Bytes read |
| -------------------- | ------------------------------------------------------ | ------ | --------- | ---------- |
| `WHERE` baseline     | 0.070, 0.069, 0.057, 0.055, 0.088, 0.062, 0.057, 0.069 | 0.065  | 425,730   | 29,860,383 |
| `PREWHERE` candidate | 0.084, 0.061, 0.079, 0.077, 0.059, 0.060, 0.060, 0.074 | 0.067  | 425,730   | 21,168,864 |

`PREWHERE` reduced bytes read but was faster in only three of eight pairs. The
`WHERE` baseline is retained; no latency improvement is claimed for the
candidate, and optimization stopped at this result. These measurements describe
this fixture, not a latency guarantee.

## Job name and workflow ID set (2026-10-23)

The lookup also returns `default.workflow_job.name` as `github_workflow_job_name`
(public `github_workflow.job_name`); an empty name becomes `null`. Validated
against live, read-only ClickHouse with working-tree SQL, bound parameters and
the query cache disabled.

The fixture has 100 job IDs: 93 distinct jobs from one test's newest 100 runs
across 19 commits, job `119695966254`, the two attempt jobs above, one repeated
ID, and `-9223372036854775808`, `0` and `9223372036854775807`. Every variant
returned the same 97 rows: 96 jobs and the zero-ID row.

The functional baseline, the previous query plus only the name column, returned
the previous query's rows exactly, plus the new column. Job `119695966254` is
named `unit-test / inductor-cpu-core-test (3.12) / test (inductor_core, 1, 2,
mt-l-x86iavx512-8-64)`, and the zero-ID job's empty name is `null`. An
independent oracle read all 117,535 retained `FINAL` rows for these jobs, chose
the latest row per ID in JavaScript with the same ordering, and matched all 97
names.

The baseline evaluated the `jobs` CTE twice, once only to collect workflow IDs.
The adopted rewrite collects them from a plain read of the requested jobs. That
yields every stored run ID of those jobs, a superset of the selected rows' IDs,
and a workflow outside the selection matches no job in the join. Among 21.0M job
rows inserted since 2026-07-27, no job ID had more than one workflow ID, so both
sets were identical in practice. `EXPLAIN indexes=1` kept 48 of 32,112 job
granules and 12 of 14,643 workflow granules for every variant, and 48 job
granules for the new subquery.

Medians of eight alternating pairs, in server seconds:

| Comparison                                | Before | After | Faster | Bytes read (MB) |
| ----------------------------------------- | ------ | ----- | ------ | --------------- |
| Previous query → baseline with name       | 0.066  | 0.072 | 2 of 8 | 32.6 → 38.5     |
| Baseline → `PREWHERE`                     | 0.076  | 0.091 | 2 of 8 | 38.6 → 27.4     |
| Baseline → plain-read workflow IDs        | 0.068  | 0.048 | 8 of 8 | 38.6 → 29.8     |
| Plain-read workflow IDs → plus `PREWHERE` | 0.046  | 0.051 | 3 of 8 | 29.9 → 20.6     |
| Baseline → working tree                   | 0.075  | 0.047 | 8 of 8 | 38.7 → 29.9     |

Every candidate execution returned the baseline's rows. The plain-read workflow
IDs are adopted; `PREWHERE` was rejected again, and optimization stopped there.

## Shared lookup for page selection (2026-10-23)

Page selection's `workflow_path` filter and sort now read workflow metadata
through `workflowMetadataSql`, the builder enrichment uses, so a run is filtered
and sorted by the path it returns. For selection this changes one thing:
workflow IDs come from a plain read of the selected jobs instead of a second
evaluation of its `jobs` CTE, as in the enrichment rewrite above. The enrichment
SQL is unchanged byte for byte.

Validated with working-tree SQL against live, read-only ClickHouse with the
query cache disabled and limit 100, comparing the previous page SQL with the
shared-builder SQL. Test `8596366215354190393` was filtered by
`.github/workflows/pull.yml` and sorted by `workflow_path,-started_at`; commit
`de09df22e85a661e656e93a476d614a1779d45f6` was filtered by
`.github/workflows/inductor.yml` and sorted by `-workflow_path`. Every
execution returned the same 101 rows as the previous SQL, and
`EXPLAIN indexes=1` kept the same granules for both versions: 412 of 32,111 job
and 288 of 14,642 workflow granules for the test.

| Case                | Pairs | Before | After | Faster | Bytes read           |
| ------------------- | ----- | ------ | ----- | ------ | -------------------- |
| Test, path filter   | 8     | 0.406  | 0.377 | 5 of 8 | 360 MB → 274 MB      |
| Test, path sort     | 8     | 0.423  | 0.421 | 5 of 8 | 360 MB → 274 MB      |
| Commit, path filter | 6     | 9.858  | 8.821 | 4 of 6 | 38.83 GB, within 1MB |
| Commit, path sort   | 3     | 9.823  | 7.439 | 2 of 3 | 38.83 GB, within 1MB |

Medians are server seconds. Latency differences are within run-to-run noise,
with no regression. The same commit page without a workflow option read 816M
rows and 38.4 GB, so commit pages are dominated by the documented `FINAL` read
of the commit's partitions rather than by this lookup. The commit sort case
used three pairs to limit load from those reads.
