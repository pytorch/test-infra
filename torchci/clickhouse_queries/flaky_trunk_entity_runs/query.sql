-- Flaky Trunk row-click drill-down: the individual FAILED runs behind ONE clicked entity.
--
-- Given a job (entityType='job') or a runner/instance label (entityType='label'), returns one row per
-- FAILED default.workflow_job run that belongs to a logical outcome classified as a flake. A "logical
-- outcome" is one (commit, workflow, job-shard) collapsed across every run_attempt / restart run_id;
-- flake = infra_flake (advisor infra_issue, persistent or not) OR test_flake (advisor
-- not_related/garbage; advisor-only). real_regression (advisor related/revert, or a persistent
-- fallback) and unclassified reds (non-persistent, no advisor verdict) are excluded.
--
-- The classification chain (trunk_commits .. final_jobs) is the same logic used by flaky_trunk_jobs and
-- flaky_trunk_runner_labels, so categories are IDENTICAL to those aggregate tables; this query
-- additionally carries head_sha through job_signals/final_jobs so each classified logical outcome can be
-- joined back to its raw failed runs. Trunk filter: head_sha is a real push to refs/heads/main for repo.
--
--   entityType='job'   -> runs of the job whose displayed name ("<workflow> / <norm_name>", the same
--                         expression flaky_trunk_jobs SELECTs) equals entityValue; BOTH infra_flake and
--                         test_flake outcomes.
--   entityType='label' -> failed runs whose labels array contains entityValue; infra_flake outcomes only
--                         (the runner-labels view is infra-flakiness), matching flaky_trunk_runner_labels.
--
-- html_url is the GitHub Actions job page: the native workflow_job.html_url is populated and already
-- reflects the true repo, so it is used directly; the {repo}-based construction is only a fallback for
-- the rare empty value. LIMIT 2000 caps a single entity's flake runs over the window.
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
        c.head_sha AS head_sha,
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
        head_sha,
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
            head_sha,
            workflow_name,
            cons_name,
            norm_name,
            commit_time,
            is_green,
            is_red,
            adv_real,
            adv_infra,
            adv_testflake,
            -- persistent: this job's adjacent observed run is also hard-red (>= 2 of its runs in a row).
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
),

-- Only the logical outcomes classified as flake (test_flake=3, infra_flake=4), keyed for the join-back.
flake_outcomes AS (
    SELECT
        head_sha,
        workflow_name,
        cons_name,
        category
    FROM final_jobs
    WHERE category IN (3, 4)
),

-- Raw FAILED runs for the clicked entity only, deduped to one row per job id (SharedReplacingMergeTree).
failed_runs AS (
    SELECT
        j.head_sha AS head_sha,
        j.name AS job_name,
        j.workflow_name AS workflow_name,
        replaceRegexpOne(
            j.name, ', ([0-9]+), ([0-9]+), [^)]+\\)$', ', \\1, \\2)'
        ) AS cons_name,
        j.labels AS labels,
        j.runner_group_name AS runner_group_name,
        toDateTime(j.started_at) AS started_at,
        j.html_url AS html_url,
        j.run_id AS run_id,
        j.id AS id
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
        AND j.conclusion = 'failure'
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
        AND (
            (
                {entityType: String} = 'job'
                AND concat(
                    j.workflow_name,
                    ' / ',
                    replaceRegexpOne(
                        replaceRegexpOne(
                            j.name,
                            ', ([0-9]+), ([0-9]+), [^)]+\\)$',
                            ', \\1, \\2)'
                        ),
                        ', [0-9]+, [0-9]+\\)$', ')'
                    )
                ) = {entityValue: String}
            )
            OR
            (
                {entityType: String} = 'label'
                AND has(
                    if(empty(j.labels), [''], j.labels), {entityValue: String}
                )
            )
        )
    ORDER BY j._inserted_at DESC
    LIMIT 1 BY id
)

SELECT
    r.head_sha AS head_sha,
    r.job_name AS job_name,
    CAST(r.workflow_name AS String) AS workflow_name,
    if(f.category = 4, 'Infra flake', 'Job flake') AS category,
    if(
        empty(r.labels), r.runner_group_name, arrayStringConcat(r.labels, ', ')
    ) AS runner_label,
    r.started_at AS started_at,
    if(
        r.html_url != '',
        r.html_url,
        concat(
            'https://github.com/',
            {repo: String},
            '/actions/runs/',
            toString(r.run_id),
            '/job/',
            toString(r.id)
        )
    ) AS html_url,
    toInt64(r.run_id) AS run_id,
    toInt64(r.id) AS id
FROM failed_runs r
INNER JOIN flake_outcomes f
    ON
        r.head_sha = f.head_sha
        AND r.workflow_name = f.workflow_name
        AND r.cons_name = f.cons_name
WHERE {entityType: String} != 'label' OR f.category = 4
ORDER BY started_at DESC
LIMIT 2000
