-- Flaky Trunk Jobs & Runner Labels HUD page: time-series of trunk (main) job outcomes.
--
-- One row per time bucket, aggregating over ALL trunk jobs. A "logical job outcome" is one
-- (commit, workflow, job-shard) collapsed across every run_attempt / restart run_id: green if
-- it ever succeeded and never failed, red if it ever failed. Every red is then classified as
-- flake / real / unknown (flake + real + unknown = red; green + red = total_runs).
--
-- Trunk filter: jobs whose head_sha is a real push to refs/heads/main for the repo param (join to
-- default.push, which also yields the commit push timestamp used for bucketing + adjacency).
-- The shared CTE chain (trunk_commits .. final_jobs) is identical across flaky_trunk_timeseries,
-- flaky_trunk_jobs and flaky_trunk_runner_labels.
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
        maxIf(1, verdict IN ('infra_issue', 'not_related', 'garbage')) AS advisor_flake,
        maxIf(1, verdict IN ('related', 'revert')) AS advisor_real
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
raw_jobs AS (
    SELECT
        j.head_sha AS head_sha,
        tc.commit_time AS commit_time,
        j.workflow_name AS workflow_name,
        -- cons_name keeps the shard (config, i, n) but drops the trailing runner, so a retry on a
        -- different runner/fleet collapses into the same shard; norm_name additionally drops the shard.
        replaceRegexpOne(j.name, ', ([0-9]+), ([0-9]+), [^)]+\\)$', ', \\1, \\2)') AS cons_name,
        j.conclusion AS conclusion,
        if(
            tupleElement(j.torchci_classification, 'line') = '',
            tupleElement(j.torchci_classification_temp, 'rule'),
            tupleElement(j.torchci_classification, 'rule')
        ) AS rule,
        upper(ann.annotation) AS annotation
    FROM default.workflow_job j
    INNER JOIN trunk_commits tc ON j.head_sha = tc.head_sha
    LEFT JOIN default.job_annotation ann ON ann.jobID = j.id
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
        maxIf(rule IN ('pytest failure', 'Python unittest failure'), conclusion = 'failure') AS has_test_rule,
        max(annotation IN ('TEST_FLAKE', 'INFRA_FLAKE', 'INFRA_BROKEN', 'NETWORK')) AS ann_flake,
        max(annotation = 'BROKEN_TRUNK') AS ann_real
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
        toUInt8(c.has_success AND c.has_failure) AS retry_green,
        c.has_test_rule AS has_test_rule,
        toUInt8(c.ann_flake OR ifNull(aa.advisor_flake, 0) = 1) AS ext_flake,
        toUInt8(c.ann_real OR ifNull(aa.advisor_real, 0) = 1) AS ext_real
    FROM consolidated c
    LEFT JOIN advisor_agg aa ON aa.head_sha = c.head_sha AND aa.adv_norm = c.norm_name
),
final_jobs AS (
    SELECT
        workflow_name,
        cons_name,
        norm_name,
        commit_time,
        is_green,
        is_red,
        is_flake,
        multiIf(is_red = 0, 0, is_flake = 1, 0, ext_real = 1, 1, 0) AS is_real,
        multiIf(is_red = 0, 0, is_flake = 1, 0, ext_real = 1, 0, 1) AS is_unknown,
        toUInt8(is_flake = 1 AND has_test_rule = 1) AS is_test_flake,
        toUInt8(is_flake = 1 AND has_test_rule = 0) AS is_infra_flake
    FROM (
        SELECT
            workflow_name,
            cons_name,
            norm_name,
            commit_time,
            is_green,
            is_red,
            has_test_rule,
            ext_real,
            -- flake wins ties over real: retry-green, adjacent green->red->green, advisor or annotation flake
            toUInt8(
                is_red = 1
                AND (
                    retry_green = 1
                    OR ext_flake = 1
                    OR (lagInFrame(is_green) OVER w = 1 AND leadInFrame(is_green) OVER w = 1)
                )
            ) AS is_flake
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
    countIf(is_green = 1) AS green,
    countIf(is_red = 1) AS red,
    countIf(is_flake = 1) AS flake,
    countIf(is_real = 1) AS real,
    countIf(is_unknown = 1) AS unknown,
    round(if(green + flake = 0, 0, flake / (green + flake)), 4) AS flake_rate,
    round(if(red = 0, 0, flake / red), 4) AS pct_reds_flake,
    round(if(real + flake = 0, 0, real / (real + flake)), 4) AS precision
FROM final_jobs
GROUP BY bucket
ORDER BY bucket
