"""ClickHouse SQL for pre-merge trunk-gate classification (see premerge.py)."""


MERGE_HEAD_SQL = """
SELECT last_commit_sha, skip_mandatory_checks
FROM default.merges FINAL
WHERE merge_commit_sha = {merge_commit:String}
  AND project = {project:String}
  AND owner = {owner:String}
  AND last_commit_sha != ''
ORDER BY comment_id DESC
LIMIT 1
"""

# By-sha miss fallback: default.merges.merge_commit_sha often differs from the sha that
# lands on main (final rebase at merge time), so the squashed title's (#PR) resolves the
# pre-merge head when the by-sha lookup finds nothing. Title carries (#NNNNN).
COMMIT_MSG_ONE_SQL = """
SELECT arrayFilter(x -> x.'id' = {commit:String}, commits)[1].'message'
FROM default.push ARRAY JOIN commits AS commit
WHERE ref = 'refs/heads/main' AND commit.id = {commit:String}
LIMIT 1
"""

MERGE_HEAD_BY_PR_SQL = """
SELECT DISTINCT last_commit_sha, skip_mandatory_checks
FROM default.merges
WHERE pr_num = {pr:Int64}
  AND owner = {owner:String}
  AND project = {project:String}
  AND last_commit_sha != ''
  AND dry_run = 0
  AND is_failed = 0
"""

MERGE_TS_SQL = """
SELECT min(commit.timestamp) AS ts
FROM default.push ARRAY JOIN commits AS commit
WHERE ref = 'refs/heads/main' AND commit.id = {merge_commit:String}
"""

# Step A: pre-merge gate jobs on the validated head. created_at <= merge_ts EXCLUDES
# post-merge reruns on the reused PR/ghstack branch (those would wrongly show failures).
PREMERGE_JOBS_SQL = """
SELECT id
FROM default.workflow_job FINAL
WHERE head_sha = {head_sha:String}
  AND created_at >= {lower:DateTime}
  AND created_at <= {merge_ts:DateTime}
  AND name NOT LIKE '%mem_leak_check%'
  AND name NOT LIKE '%rerun_disabled_tests%'
  AND name NOT LIKE '%unstable%'
"""

# Step B: aggregate the target test across those jobs. Partition-pruned on time_inserted.
PREMERGE_TEST_SQL = """
SELECT
    sum(failure_count + error_count) AS fails,
    sum(if(failure_count = 0 AND error_count = 0 AND skipped_count = 0, 1, 0)) AS successes,
    sum(if(skipped_count > 0 AND failure_count = 0 AND error_count = 0, 1, 0)) AS skips,
    count() AS rows
FROM tests.all_test_runs
WHERE job_id IN {job_ids:Array(Int64)}
  AND toDate(time_inserted) >= toDate({tlow:DateTime})
  AND file = {file:String}
  AND name = {name:String}
GROUP BY file, name
"""

# Failing-config resolution, step A: test jobs on the LANDED commit (head_sha = the merged
# sha on main), keyed by name so build_env/test_config can be parsed. Bounded by created_at
# around the merge window so the workflow_job scan stays small. FINAL dedupes the
# ReplacingMergeTree; only '% / test (%' jobs carry a (build_env, test_config).
MAIN_JOBS_SQL = """
SELECT id, name
FROM default.workflow_job FINAL
WHERE head_sha = {commit:String}
  AND created_at >= {lower:DateTime}
  AND created_at <= {upper:DateTime}
  AND name LIKE '% / test (%'
"""

# Failing-config resolution, step B: which (job_id, file, name) FAILED on the landed commit.
# job_id IN uses the tests.all_test_runs primary-key prefix (ORDER BY job_id, ...) so this
# stays fast; toDate(time_inserted) prunes partitions. The caller maps job_id -> job name
# -> (build_env, test_config) to build the per-(file, name) failing-config set.
MAIN_FAILING_TESTS_SQL = """
SELECT job_id, file, name
FROM tests.all_test_runs
WHERE job_id IN {job_ids:Array(Int64)}
  AND toDate(time_inserted) >= toDate({tlow:DateTime})
  AND (failure_count + error_count) > 0
GROUP BY job_id, file, name
"""
