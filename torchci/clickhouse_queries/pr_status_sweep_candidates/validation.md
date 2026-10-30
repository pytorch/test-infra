# Candidate query validation

Validated on 2026-11-02 against the live HUD ClickHouse database through its
read-only Grafana datasource, using the SQL from this working tree and the
parameters in `params.json`.

The table DDL confirms that `pull_request` is a ReplacingMergeTree sorted by
`(number, dynamoKey)`, with `created_at` stored as a GitHub ISO string.
`issue_comment` is sorted by `(issue_url, dynamoKey)`. Both reads retain `FINAL`
so old labels or comment bodies do not qualify a PR after replacement.

The query returned 1,295 candidates from 3,907 open PyTorch PRs: 1,212 qualified
by their rollout date and labels; another 83 qualified through an existing
bot-authored status section. At 100 PRs every 15 minutes, a stable queue of this
size takes 13 runs (3 hours 15 minutes) to cover, rather than 40 runs for all
open PRs. Candidate discovery makes no GitHub search requests.

## Query comparison

The baseline uses the same query except that the comment subquery considers
all open PRs: remove `WHERE NOT in_workflow` from its inner `issue_url` lookup.
The final query skips comment lookups for PRs already selected by labels.
`EXPLAIN indexes = 1` showed the issue-comment primary-key lookup shrinking
from 3,907 URLs / 182 of 369 granules to 2,695 URLs / 181 of 369 granules.
The PR scan is repeated to bound the comment read by its sort key; the CTE
does not materialize a shared result.

Three alternating executions returned exactly the same ordered 1,295 PR IDs.
Parameters were fixed, with `use_query_cache = 0`, `max_threads = 4`, and
`max_execution_time = 30`. These are end-to-end seconds through Grafana,
including network overhead, not isolated database execution times:

| Run | Baseline | Final |
| --- | -------- | ----- |
| 1   | 1.588    | 1.359 |
| 2   | 1.147    | 0.978 |
| 3   | 3.000    | 1.152 |

A further rewrite split the label and stale-comment branches with `UNION ALL`.
Three alternating pairs again returned identical PR IDs; the live population
had grown to 1,296. Final-query times were 1.228, 1.467, and 1.749 seconds;
the union took 1.348, 1.197, and 3.083 seconds. That provided no consistent
improvement, so the simpler query was retained. The small granule reduction
and variable network timings do not support a large database-speedup claim;
the main benefit is eliminating GitHub searches and reducing the rotation.

The SQLFluff 3.3.0 formatting fix (including `ifNull` → `COALESCE`) was checked
against the preceding query with the same parameters and settings. Three
alternating pairs returned identical ordered lists of 1,296 PR IDs. The preceding
query took 1.138, 1.275, and 1.073 seconds; the formatted query took 1.363, 0.990,
and 1.599 seconds. `EXPLAIN indexes = 1` retained the same primary-key pruning,
and all selection fixtures below passed again, including a null rollout date.
The repository's SQLFLUFF and SQL_PARAMS lintrunner checks pass.

## Selection checks

The working-tree selection predicates were also executed against 14 synthetic
PRs using read-only `values` CTEs in ClickHouse. They verified:

- Post-rollout workflow labels select PRs even without a comment.
- Missing-actionable-issue holds and the exact rollout boundary are included.
- Removed labels still qualify when the bot's current Dr.CI comment has status.
- Pre-rollout PRs qualify only for stale-status cleanup.
- Closed PRs, other repositories, and unrelated labels are excluded.
- A human comment containing both markers cannot qualify a PR.
- Bot comments containing only one of the two markers cannot qualify a PR.
- Multiple matching bot comments do not duplicate a candidate.
- A null rollout date disables label-based discovery but retains cleanup.

The fixture CTEs use the experimental analyzer to resolve their named tuple
aliases; production-table queries above were checked with the default analyzer.
No production data was written. Jest separately covers live state changes
after discovery, missing comments, rotating batches, reader/writer separation,
and query failure without a GitHub-search fallback.
