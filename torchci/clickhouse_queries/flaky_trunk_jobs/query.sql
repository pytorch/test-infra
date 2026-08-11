-- Flaky Trunk Jobs & Runner Labels HUD page: per-job flakiness on trunk (main).
--
-- One row per normalized job entity ("<workflow> / <job without shard/runner>"), aggregating its
-- logical outcomes across every trunk commit in the window. A "logical job outcome" is one
-- (commit, workflow, job-shard) collapsed across every run_attempt / restart run_id: green if it
-- ever succeeded and never failed, red if it ever failed. Every red is assigned to exactly ONE of
-- five mutually-exclusive categories (green + red = total_runs;
-- infra_flake + test_flake + unclassified + real_regression + sustained_infra = red):
--   real_regression  advisor said related/revert, OR a persistent hard-red run whose failure is a test rule.
--   sustained_infra  a persistent hard-red run whose failure is NOT a test rule (infra broke for >= 2 commits).
--   test_flake       intermittent flake on a test rule (retry-green, green->red->green, advisor/annotation flake).
--   infra_flake      intermittent flake on a non-test rule (same signals).
--   unclassified     an isolated single-commit hard-red with no retry, no green->red->green, no persistence,
--                    and no advisor/annotation signal.
-- flake here = infra_flake + test_flake (intermittent only); flake_rate = flake / (green + flake).
-- Persistence is the key discriminator: a hard-red (failed, no retry-green at this commit) is "persistent"
-- when the SAME job is also hard-red at the immediately previous OR next trunk commit; a hard-red with a
-- clean green on BOTH neighbors is an isolated green->red->green flake. real_regression / sustained_infra
-- are NOT gated on later recovery, so an ongoing (still-red) break still counts.
--
-- Trunk filter: jobs whose head_sha is a real push to refs/heads/main for the repo param. The shared CTE
-- chain (trunk_commits .. final_jobs) is identical across flaky_trunk_timeseries, flaky_trunk_jobs
-- and flaky_trunk_runner_labels.
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
        toUInt8(c.has_failure AND NOT c.has_success) AS hard_red,
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
        -- Exactly one category per logical red, in precedence order (0 = not red):
        --   1 real_regression, 2 sustained_infra, 3 test_flake, 4 infra_flake, 5 unclassified.
        multiIf(
            is_red = 0, 0,
            ext_real = 1 OR (persistent = 1 AND has_test_rule = 1), 1,
            persistent = 1 AND has_test_rule = 0, 2,
            (retry_green = 1 OR grg_flake = 1 OR ext_flake = 1) AND has_test_rule = 1, 3,
            (retry_green = 1 OR grg_flake = 1 OR ext_flake = 1) AND has_test_rule = 0, 4,
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
            retry_green,
            has_test_rule,
            ext_flake,
            ext_real,
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
agg AS (
    SELECT
        concat(workflow_name, ' / ', norm_name) AS job_name,
        countIf(is_green = 1 OR is_red = 1) AS total_runs,
        countIf(is_green = 1) AS green,
        countIf(is_red = 1) AS red,
        countIf(category = 4) AS infra_flake,
        countIf(category = 3) AS test_flake,
        countIf(category = 5) AS unclassified,
        countIf(category = 1) AS real_regression,
        countIf(category = 2) AS sustained_infra,
        countIf(category IN (3, 4)) AS flake
    FROM final_jobs
    GROUP BY job_name
    HAVING total_runs >= {minRuns: Int32}
)
SELECT
    job_name,
    total_runs,
    green,
    red,
    infra_flake,
    test_flake,
    unclassified,
    real_regression,
    sustained_infra,
    round(if(green + flake = 0, 0, flake / (green + flake)), 4) AS flake_rate,
    -- Wilson score 95% lower bound (z = 1.96) on flake / (green + flake)
    round(if(green + flake = 0, 0,
        ((flake / (green + flake) + 3.8416 / (2 * (green + flake)))
         - 1.96 * sqrt(flake / (green + flake) * (1 - flake / (green + flake)) / (green + flake)
                       + 3.8416 / (4 * (green + flake) * (green + flake))))
        / (1 + 3.8416 / (green + flake))), 4) AS flake_rate_wilson_lb,
    round(if(red = 0, 0, flake / red), 4) AS pct_reds_flake
FROM agg
ORDER BY flake_rate_wilson_lb DESC, flake DESC
