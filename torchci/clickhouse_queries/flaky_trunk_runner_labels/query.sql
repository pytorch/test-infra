-- Flaky Trunk Jobs & Runner Labels HUD page: infra-flakiness attributed to runner labels on trunk.
--
-- One row per runner label. Each trunk logical job outcome (one (commit, workflow, job-shard)
-- collapsed across every run_attempt / restart run_id) is attributed to the runner label(s) it ran
-- on. A label's red / infra_flake counts only include jobs that FAILED on that label.
-- infra_flake = infra flakiness on the label (advisor infra_issue, persistent or not). flake_rate is
-- the label's infra-flake rate over all jobs it ran. works_elsewhere_pct — share of a label's
-- infra-flake jobs that succeeded on a DIFFERENT label — is the pool-fault discriminator (high =
-- the label/pool is the problem, not the job).
--
-- flake_rate counts infra_flake only; test flakes are job faults, not pool faults.
-- The classification chain (trunk_commits .. category)
-- is the same logic used by flaky_trunk_timeseries and flaky_trunk_jobs; this query additionally
-- carries the per-job set of pass/fail runner labels.
WITH
trunk_commits AS (
    SELECT
        tupleElement(head_commit, 'id') AS head_sha,
        min(tupleElement(head_commit, 'timestamp')) AS commit_time
    FROM default.push
    WHERE ref = 'refs/heads/main'
      AND tupleElement(repository, 'full_name') = {repo: String}
      AND tupleElement(head_commit, 'timestamp') >= {startTime: DateTime64(3)}
      AND tupleElement(head_commit, 'timestamp') < {stopTime: DateTime64(3)}
    GROUP BY head_sha
),
-- Latest AI advisor verdict per (trunk commit, normalized job). signal_key comes in two shapes:
-- 'dr_ci_<workflow> / <job>' (Dr.CI / PR-side) and, for trunk autorevert, a bare (already
-- normalized) '<job>' optionally suffixed ' [test]'. Both are reduced to the normalized job name.
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
                    if(
                        startsWith(signal_key, 'dr_ci_'),
                        arrayStringConcat(arraySlice(splitByString(' / ', substring(signal_key, 7)), 2), ' / '),
                        signal_key
                    ),
                    ' \\[[^\\]]+\\]$', ''
                ),
                ', [0-9]+, [0-9]+, .+\\)', ')'
            ) AS adv_norm,
            argMax(verdict, timestamp) AS verdict
        FROM misc.autorevert_advisor_verdicts
        WHERE repo = {repo: String}
          AND signal_source = 'job'
          AND timestamp >= {startTime: DateTime64(3)}
        GROUP BY suspect_commit, signal_key
    )
    GROUP BY head_sha, adv_norm
),
-- arrayJoin(labels) explodes to one runner label per attempt (labels is single-element in practice,
-- so this does not inflate the consolidated booleans, which are all countIf>0 / max and label-invariant).
raw_jobs AS (
    SELECT
        j.head_sha AS head_sha,
        tc.commit_time AS commit_time,
        j.workflow_name AS workflow_name,
        replaceRegexpOne(j.name, ', ([0-9]+), ([0-9]+), [^)]+\\)$', ', \\1, \\2)') AS cons_name,
        j.conclusion AS conclusion,
        arrayJoin(if(empty(j.labels), [''], j.labels)) AS label
    FROM default.workflow_job j
    INNER JOIN trunk_commits tc ON j.head_sha = tc.head_sha
    WHERE j.created_at >= {startTime: DateTime64(3)}
      AND j.created_at < {stopTime: DateTime64(3)}
      AND j.conclusion IN ('success', 'failure')
      AND j.name LIKE '%/%'
      AND j.name NOT LIKE '%rerun_disabled_tests%'
      AND j.name NOT LIKE '%mem_leak_check%'
      AND j.name NOT LIKE '%unstable%'
),
consolidated AS (
    SELECT
        head_sha,
        workflow_name,
        cons_name,
        any(commit_time) AS commit_time,
        replaceRegexpOne(cons_name, ', [0-9]+, [0-9]+\\)$', ')') AS norm_name,
        countIf(conclusion = 'success') > 0 AS has_success,
        countIf(conclusion = 'failure') > 0 AS has_failure,
        groupUniqArrayIf(label, conclusion = 'failure') AS fail_labels,
        groupUniqArrayIf(label, conclusion = 'success') AS success_labels
    FROM raw_jobs
    GROUP BY head_sha, workflow_name, cons_name
),
job_signals AS (
    SELECT
        c.workflow_name AS workflow_name,
        c.cons_name AS cons_name,
        c.norm_name AS norm_name,
        c.commit_time AS commit_time,
        c.fail_labels AS fail_labels,
        c.success_labels AS success_labels,
        toUInt8(c.has_success AND NOT c.has_failure) AS is_green,
        toUInt8(c.has_failure) AS is_red,
        toUInt8(c.has_success AND c.has_failure) AS retry_green,
        toUInt8(c.has_failure AND NOT c.has_success) AS hard_red,
        ifNull(aa.advisor_real, 0) AS adv_real,
        ifNull(aa.advisor_infra, 0) AS adv_infra,
        ifNull(aa.advisor_testflake, 0) AS adv_testflake
    FROM consolidated c
    LEFT JOIN advisor_agg aa ON aa.head_sha = c.head_sha AND aa.adv_norm = c.norm_name
),
final_jobs AS (
    SELECT
        norm_name,
        fail_labels,
        success_labels,
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
            norm_name,
            fail_labels,
            success_labels,
            is_red,
            retry_green,
            adv_real,
            adv_infra,
            adv_testflake,
            -- persistent: this hard-red has an adjacent hard-red on trunk (run of >= 2 consecutive reds).
            toUInt8(hard_red = 1 AND (lagInFrame(hard_red) OVER w = 1 OR leadInFrame(hard_red) OVER w = 1)) AS persistent,
            -- grg_flake: isolated hard-red with a clean green on BOTH adjacent trunk commits.
            toUInt8(hard_red = 1 AND lagInFrame(is_green) OVER w = 1 AND leadInFrame(is_green) OVER w = 1) AS grg_flake
        FROM job_signals
        WINDOW w AS (
            PARTITION BY workflow_name, cons_name
            ORDER BY commit_time
            ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING
        )
    )
),
per_label AS (
    SELECT
        arrayJoin(arrayDistinct(arrayConcat(fail_labels, success_labels))) AS label,
        fail_labels,
        success_labels,
        norm_name,
        is_red,
        category
    FROM final_jobs
),
agg AS (
    SELECT
        label,
        count() AS total_runs,
        countIf(has(fail_labels, label) AND is_red = 1) AS red,
        countIf(has(fail_labels, label) AND category = 4) AS infra_flake,
        countIf(has(fail_labels, label) AND category = 4 AND arrayExists(x -> x != label, success_labels)) AS infra_flake_elsewhere_green,
        uniqExactIf(norm_name, has(fail_labels, label) AND category = 4) AS distinct_jobs_hit
    FROM per_label
    GROUP BY label
    HAVING total_runs >= {minRuns: Int32}
)
SELECT
    label,
    total_runs,
    red,
    infra_flake,
    round(if(total_runs = 0, 0, infra_flake / total_runs), 4) AS flake_rate,
    -- Wilson score 95% lower bound (z = 1.96) on infra_flake / total_runs
    round(if(total_runs = 0, 0,
        ((infra_flake / total_runs + 3.8416 / (2 * total_runs))
         - 1.96 * sqrt(infra_flake / total_runs * (1 - infra_flake / total_runs) / total_runs
                       + 3.8416 / (4 * total_runs * total_runs)))
        / (1 + 3.8416 / total_runs)), 4) AS flake_rate_wilson_lb,
    round(if(infra_flake = 0, 0, infra_flake_elsewhere_green / infra_flake), 4) AS works_elsewhere_pct,
    distinct_jobs_hit
FROM agg
ORDER BY flake_rate_wilson_lb DESC
