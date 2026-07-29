-- Powers the "Sole viable/strict blockers" table on
-- https://hud.pytorch.org/reliability/pytorch/pytorch
--
-- Approximates the viable/strict gate for FAILURE ATTRIBUTION -- it is not a
-- full reimplementation. It uses the same job-level red definition as
-- pytorch/.github/scripts/fetch_latest_green_commit.py (via commit_jobs_batch_query):
--   * gating workflows are prefix-matched against ^(pull|trunk|lint|docs-build)
--     (case-insensitive), same as the `requires` list in update-viablestrict.yml
--   * a job blocks if its latest run attempt (per workflow run) has a
--     conclusion_kg other than success/skipped
--   * jobs marked unstable (name contains "unstable", or the shard-folded name
--     matches an open UNSTABLE issue) are excluded from gating
--
-- It differs from the real gate in one bounded way: the gate also rejects a
-- commit when a required workflow never reported at all ("missing required
-- workflows"). This query only models the job-failure path, so a decided commit
-- that is entirely missing a required workflow (or that has no gating jobs at
-- all) is treated as green here rather than blocked. On post-merge main all four
-- gating workflows run on every push, so that case is rare; treat the numbers as
-- descriptive triage, not the gate's true rate.
--
-- Job names are folded to config granularity by stripping only the trailing
-- shard fields (", <shard>, <num_shards>[, <runner>]") from the final config
-- group and keeping the rest of the name. So
-- `trunk / linux-jammy-rocm-py3.10-mi350 / test (default, 1, 3)` becomes
-- `trunk / linux-jammy-rocm-py3.10-mi350 / test (default)`, and nested jobs with
-- more than two " / " components keep their config instead of collapsing, e.g.
-- `... / dynamo-test (3.11) / test (dynamo_wrapped, 1, 7)` and
-- `... / dynamo-test (3.11) / test (dynamo_core, 1, 1)` stay distinct. One row is
-- returned per fully-evaluated commit with the list of blocking folded jobs; the
-- client computes how often each job (and each job type) is the *only* blocker.
WITH commits AS (
    SELECT DISTINCT
        p.head_commit. 'id' AS sha,
        p.head_commit. 'timestamp' AS time,
        -- first line of the commit message, for the commit-range caption
        substring(arrayElement(splitByChar('\n', p.head_commit. 'message'), 1), 1, 120) AS title
    FROM
        default.push p
    WHERE
        p.ref = 'refs/heads/main'
        AND p.repository. 'owner'.'name' = 'pytorch'
        AND p.repository. 'name' = 'pytorch'
        AND p.head_commit. 'timestamp' >= {startTime: DateTime64(3) }
        AND p.head_commit. 'timestamp' < {stopTime: DateTime64(3) }
),
-- Open UNSTABLE issues, trimmed to the shard-folded job name they disable
unstable_jobs AS (
    SELECT
        trim(substring(issue.title, length('UNSTABLE') + 1)) AS name
    FROM
        default.issues AS issue FINAL
    WHERE
        arrayExists(x -> x. 'name' = 'unstable', issue.labels)
        AND issue.state = 'open'
        AND issue.title LIKE 'UNSTABLE%'
),
-- Every gating job (raw shard-attempt rows) for the commits in range
raw_jobs AS (
    SELECT
        w.head_sha AS sha,
        w.id AS workflow_id,
        -- Fold shards only: strip a trailing ", <shard>, <num_shards>[, <runner>]"
        -- from the final config group and keep the rest of the (possibly nested)
        -- name, so jobs with more than two " / " components don't collapse distinct
        -- configs (e.g. dynamo_core vs dynamo_wrapped).
        CONCAT(
            j.workflow_name,
            ' / ',
            replaceRegexpOne(j.name, ', [0-9]+, [0-9]+.*\\)$', ')')
        ) AS folded_name,
        j.name AS shard,
        j.run_attempt AS run_attempt,
        j.conclusion_kg AS conclusion
    FROM
        default.workflow_job j FINAL
        INNER JOIN default.workflow_run w FINAL ON w.id = j.run_id
    WHERE
        j.id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha IN (SELECT sha FROM commits)
        )
        AND w.id IN (
            SELECT id FROM materialized_views.workflow_run_by_head_sha
            WHERE head_sha IN (SELECT sha FROM commits)
        )
        -- Gating workflow prefixes; keep in sync with the `requires` list in
        -- pytorch/pytorch .github/workflows/update-viablestrict.yml
        -- (["pull", "trunk", "lint", "docs-build"] as of 2026-07-27).
        AND match(lower(j.workflow_name), '^(pull|trunk|lint|docs-build)')
        -- Match the gate's job-level filtering (commit_jobs_batch_query), which
        -- only drops ciflow_should_run and generate-test-matrix. We additionally
        -- drop unstable and rerun_disabled_tests jobs: the gate ignores unstable
        -- via is_unstable(), and both carry a trailing config marker
        -- (", unstable" / ", rerun_disabled_tests", after the shard fields) that
        -- the shard fold strips -- which would collapse them onto, and falsely
        -- redden, the real gating job of the same config (e.g. a scheduled
        -- rerun_disabled_tests failure landing on `test (default)`). We do NOT
        -- filter `job-filter / compute` or slashless lint jobs: the gate gates on
        -- those and they fold to distinct names, so excluding them would miss real
        -- blockers or make another job look falsely sole.
        AND j.name != 'ciflow_should_run'
        AND j.name != 'generate-test-matrix'
        AND j.name NOT LIKE '%unstable%'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND w.event != 'workflow_run' -- these are unrelated to the SHA
        AND w.event != 'repository_dispatch'
        AND NOT (w.event = 'workflow_dispatch' AND w.head_branch LIKE 'trunk/%') -- restart jobs
),
-- Collapse reruns: keep the latest run attempt per shard, per workflow run.
-- workflow_id is in the key because run_attempt is a per-run counter (not
-- globally comparable), so duplicate workflow runs for one commit must stay
-- separate; folded_job below then ORs a red run in -- mirroring the gate's
-- per-(workflow_id, job) grouping in commit_jobs_batch_query.
shard_latest AS (
    SELECT
        sha,
        folded_name AS name,
        shard,
        workflow_id,
        argMax(conclusion, run_attempt) AS conclusion
    FROM
        raw_jobs
    GROUP BY
        sha,
        name,
        shard,
        workflow_id
),
-- Collapse shards: a folded job is blocking if any shard's latest attempt is a
-- real failure; pending if any shard has no terminal conclusion yet
folded_job AS (
    SELECT
        sha,
        name,
        maxIf(
            1,
            conclusion IS NOT NULL
            AND conclusion != ''
            AND conclusion NOT IN ('success', 'skipped')
        ) AS blocking,
        maxIf(1, conclusion IS NULL OR conclusion = '') AS pending
    FROM
        shard_latest
    WHERE
        name NOT IN (SELECT name FROM unstable_jobs) -- drop already-unstable jobs
    GROUP BY
        sha,
        name
),
commit_agg AS (
    SELECT
        sha,
        max(pending) AS any_pending,
        arrayFilter(x -> x != '', groupArray(IF(blocking = 1, name, ''))) AS blocking
    FROM
        folded_job
    GROUP BY
        sha
)
SELECT
    c.time AS time,
    ca.sha AS sha,
    c.title AS title,
    ca.blocking AS blocking
FROM
    commit_agg ca
    JOIN commits c ON c.sha = ca.sha
WHERE
    ca.any_pending = 0 -- only fully-evaluated commits count toward the denominator
ORDER BY
    time DESC
