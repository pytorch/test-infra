-- Alert when the Cross-Repo CI Relay (CRCR) degrades.
--
-- CRCR relays pytorch/pytorch CI into downstream repos. pytorch/crcr-test is
-- the probe repo whose jobs exercise the relay end to end, so its outcomes are
-- the relay health signal -- the same signal behind the health cards on
-- https://hud.pytorch.org/crcr.
--
-- Probe jobs named x{fail,cancel,timeout} assert the relay reports a failure,
-- cancellation or timeout correctly, so for those the pass case IS that
-- conclusion. This matches torchci/clickhouse_queries/crcr_health_last_prs.
--
-- default.crcr_workflow_job is a ReplacingMergeTree, hence FINAL, and a job can
-- be retried. Each query groups by (run_id, job_name) and takes
-- argMax(conclusion, run_attempt), so a job that failed and then passed on
-- retry counts once, as a pass.
--
-- Used by Grafana alerts:
--   - <add URL after creating the rule in pytorchci.grafana.net>


-- 1. Unexpected outcomes among nightly probe jobs in the last 24h.
--    Alert when > 0.
WITH latest_nightly AS (
    SELECT
        job_name,
        argMax(conclusion, run_attempt) AS conclusion
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = 'pytorch/crcr-test'
        AND event_type = 'nightly'
        AND status = 'completed'
        AND started_at > now() - INTERVAL 24 HOUR
    GROUP BY
        run_id,
        job_name
)

SELECT
    countIf(
        NOT (
            conclusion = 'success'
            OR (job_name LIKE '%xfail%' AND conclusion = 'failure')
            OR (job_name LIKE '%xcancel%' AND conclusion = 'cancelled')
            OR (job_name LIKE '%xtimeout%' AND conclusion = 'timed_out')
        )
    ) AS failed_nightly_probe_jobs
FROM latest_nightly;


-- 2. Pass rate of probe jobs across the last 20 relayed PRs.
--    Alert when < 0.95. A window of PRs rather than of time keeps the signal
--    stable when PR traffic is quiet, and one flaky probe in 20 PRs should not
--    page.
--    Returns 1 when there are no rows at all; query 3 covers that case.
WITH
recent_prs AS (
    SELECT pr_number
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = 'pytorch/crcr-test'
        AND status = 'completed'
        AND pr_number > 0
    GROUP BY pr_number
    ORDER BY max(started_at) DESC
    LIMIT 20
),

latest_pr_jobs AS (
    SELECT
        j.job_name,
        argMax(j.conclusion, j.run_attempt) AS conclusion
    FROM default.crcr_workflow_job AS j FINAL
    WHERE
        j.downstream_repo = 'pytorch/crcr-test'
        AND j.status = 'completed'
        AND j.pr_number IN (SELECT recent_prs.pr_number FROM recent_prs)
    GROUP BY
        j.run_id,
        j.job_name
)

SELECT
    if(
        count() > 0,
        countIf(
            conclusion = 'success'
            OR (job_name LIKE '%xfail%' AND conclusion = 'failure')
            OR (job_name LIKE '%xcancel%' AND conclusion = 'cancelled')
            OR (job_name LIKE '%xtimeout%' AND conclusion = 'timed_out')
        ) / count(),
        1
    ) AS pr_probe_pass_rate
FROM latest_pr_jobs;


-- 3. Hours since the last completed nightly probe. Alert when > 30, which is
--    one missed nightly plus slack.
--    Queries 1 and 2 cannot catch a relay that has stopped relaying: no rows
--    means no failures, which reads as healthy. Configure this rule to alert on
--    No Data as well, since an empty result is the worst case, not the best.
SELECT dateDiff('hour', max(started_at), now()) AS hours_since_nightly
FROM default.crcr_workflow_job FINAL
WHERE
    downstream_repo = 'pytorch/crcr-test'
    AND event_type = 'nightly'
    AND status = 'completed';
