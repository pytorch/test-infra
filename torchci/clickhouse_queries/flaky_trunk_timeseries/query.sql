-- Flaky Trunk Jobs & Runner Labels HUD page: time-series of trunk (main) job outcomes.
--
-- One row per time bucket of per-bucket COUNTS (not rates) feeding a stacked bar; the front-end
-- derives every percentage from these raw counts. A "logical job outcome" is one (commit, workflow,
-- job-shard) collapsed across every run_attempt / restart run_id: green if it ever succeeded and
-- never failed, red if it ever failed (green + red = total_runs). Every red is assigned to exactly
-- ONE of four mutually-exclusive categories, so
-- infra_flake + test_flake + unclassified + real_regression = red:
--   real_regression  advisor said related/revert; or, with no advisor verdict, a persistent hard-red run.
--   test_flake       advisor said not_related/garbage (advisor-only; no structural fallback).
--   infra_flake      advisor said infra_issue (persistent or not).
--   unclassified     no advisor verdict and not persistent (isolated single-commit hard-red, retry-green,
--                    or green->red->green -- any non-persistent red with no advisor verdict).
-- Classification is advisor-verdict-PRIMARY (misc.autorevert_advisor_verdicts) with a structural fallback;
-- test_flake and infra_flake are assigned ONLY from an advisor verdict (not_related/garbage
-- for test_flake, infra_issue for infra_flake), so the structural fallback yields only real_regression
-- (persistent) or unclassified (non-persistent). Persistence
-- discriminates: a hard-red (failed, no retry-green at this commit) is "persistent" when the SAME job is
-- also hard-red at the immediately previous OR next trunk commit; a hard-red with a clean green on BOTH
-- neighbors is an isolated green->red->green flake. real_regression is NOT gated on
-- later recovery, so an ongoing (still-red) break still counts.
--
-- Trunk filter: jobs whose head_sha is a real push to refs/heads/main for the repo param (join to
-- default.push, which also yields the commit push timestamp used for bucketing + adjacency).
-- The trunk_commits .. final_jobs classification chain is identical across flaky_trunk_timeseries,
-- flaky_trunk_jobs and flaky_trunk_runner_labels.
WITH
trunk_commits AS (
    SELECT
        tupleElement(head_commit, 'id') AS head_sha,
        min(tupleElement(head_commit, 'timestamp')) AS commit_time
    FROM default.push
    WHERE
        ref = 'refs/heads/main'
        AND tupleElement(repository, 'full_name') = {repo: String}
        AND tupleElement(head_commit, 'timestamp')
        >= {startTime: DateTime64(3)}
        AND tupleElement(head_commit, 'timestamp') < {stopTime: DateTime64(3)}
    GROUP BY head_sha
),

-- Latest AI advisor verdict per (trunk commit, normalized job), for signal_source = 'job'.
-- Dr.CI/PR-side verdicts ('dr_ci_' prefix) carry a PR-head suspect_commit that never equals a
-- trunk sha, so they drop out of the advisor join below and need no handling here; the
-- surviving bare trunk-autorevert keys are reduced to the normalized job name.
advisor_agg AS (
    SELECT
        head_sha,
        adv_norm,
        maxIf(1, verdict IN ('related', 'revert')) AS advisor_real,
        maxIf(1, verdict = 'infra_issue') AS advisor_infra,
        maxIf(1, verdict IN ('not_related', 'garbage')) AS advisor_testflake
    FROM (
        SELECT
            toString(suspect_commit) AS head_sha,
            replaceRegexpOne(
                replaceRegexpOne(
                    signal_key,
                    ' \\[[^\\]]+\\]$', ''
                ),
                ', [0-9]+, [0-9]+, .+\\)', ')'
            ) AS adv_norm,
            argMax(verdict, timestamp) AS verdict
        FROM misc.autorevert_advisor_verdicts
        WHERE
            repo = {repo: String}
            AND signal_source = 'job'
            AND timestamp >= {startTime: DateTime64(3)}
        GROUP BY suspect_commit, signal_key
    )
    GROUP BY head_sha, adv_norm
),

raw_jobs AS (
    SELECT
        j.head_sha AS head_sha,
        tc.commit_time AS commit_time,
        j.workflow_name AS workflow_name,
        -- cons_name keeps the shard (config, i, n) but drops the trailing runner, so a retry on a
        -- different runner/fleet collapses into the same shard; norm_name additionally drops the shard.
        replaceRegexpOne(
            j.name, ', ([0-9]+), ([0-9]+), [^)]+\\)$', ', \\1, \\2)'
        ) AS cons_name,
        j.conclusion AS conclusion
    FROM default.workflow_job j
    INNER JOIN trunk_commits tc ON j.head_sha = tc.head_sha
    WHERE
        -- Bind jobs to trunk-commit membership rather than a created_at window: a commit's retries are
        -- separate rows created arbitrarily later, so over historical/backfill windows every attempt must
        -- be counted or a late retry-green is misclassified as a hard failure. Slower than the created_at
        -- skip-index scan, but the join above is the exact filter and correctness wins here.
        j.id IN (
            SELECT id
            FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha IN (SELECT head_sha FROM trunk_commits)
        )
        AND j.conclusion IN ('success', 'failure')
        AND j.name LIKE '%/%'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND j.name NOT LIKE '%mem_leak_check%'
        AND j.name NOT LIKE '%unstable%'
        -- Restrict to viable/strict blocking workflows (keep in sync with
        -- pytorch/pytorch .github/workflows/update-viablestrict.yml `requires`).
        AND (
            {viableStrictOnly: Bool} = false
            OR lower(j.workflow_name) IN ('pull', 'trunk', 'lint', 'docs-build')
        )
),

consolidated AS (
    SELECT
        head_sha,
        workflow_name,
        cons_name,
        any(commit_time) AS commit_time,
        replaceRegexpOne(cons_name, ', [0-9]+, [0-9]+\\)$', ')') AS norm_name,
        countIf(conclusion = 'success') > 0 AS has_success,
        countIf(conclusion = 'failure') > 0 AS has_failure
    FROM raw_jobs
    GROUP BY head_sha, workflow_name, cons_name
),

job_signals AS (
    SELECT
        c.workflow_name AS workflow_name,
        c.cons_name AS cons_name,
        c.norm_name AS norm_name,
        c.commit_time AS commit_time,
        toUInt8(c.has_success AND NOT c.has_failure) AS is_green,
        toUInt8(c.has_failure) AS is_red,
        toUInt8(c.has_failure AND NOT c.has_success) AS hard_red,
        COALESCE(aa.advisor_real, 0) AS adv_real,
        COALESCE(aa.advisor_infra, 0) AS adv_infra,
        COALESCE(aa.advisor_testflake, 0) AS adv_testflake
    FROM consolidated c
    LEFT JOIN
        advisor_agg aa
        ON aa.head_sha = c.head_sha AND aa.adv_norm = c.norm_name
),

final_jobs AS (
    SELECT
        workflow_name,
        cons_name,
        norm_name,
        commit_time,
        is_green,
        is_red,
        -- Exactly one category per logical red, advisor-verdict-primary with a structural fallback:
        --   1 real_regression, 3 test_flake, 4 infra_flake, 5 unclassified.
        multiIf(
            is_red = 0, 0,
            adv_real = 1, 1,
            adv_infra = 1, 4,
            adv_testflake = 1, 3,
            persistent = 1, 1,
            5
        ) AS category
    FROM (
        SELECT
            workflow_name,
            cons_name,
            norm_name,
            commit_time,
            is_green,
            is_red,
            adv_real,
            adv_infra,
            adv_testflake,
            -- persistent: this hard-red has an adjacent hard-red on trunk (run of >= 2 consecutive reds).
            toUInt8(
                hard_red = 1
                AND (
                    lagInFrame(hard_red) OVER w = 1
                    OR leadInFrame(hard_red) OVER w = 1
                )
            ) AS persistent
        FROM job_signals
        WINDOW w AS (
            PARTITION BY workflow_name, cons_name
            ORDER BY commit_time
            ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING
        )
    )
)

SELECT
    toDateTime(DATE_TRUNC({granularity: String}, commit_time)) AS bucket,
    countIf(is_green = 1 OR is_red = 1) AS total_runs,
    countIf(is_red = 1) AS red,
    countIf(category = 4) AS infra_flake,
    countIf(category = 3) AS test_flake,
    countIf(category = 5) AS unclassified,
    countIf(category = 1) AS real_regression
FROM final_jobs
GROUP BY bucket
ORDER BY bucket
