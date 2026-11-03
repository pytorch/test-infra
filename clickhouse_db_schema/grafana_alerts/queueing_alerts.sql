-- Queueing alerts for autoscaled machines
-- ("Jobs are Queued - autoscaled-machines").
--
-- One query, one row per runner fleet: mt- (Meta clusters), lf- (Linux
-- Foundation fleet), windows (Windows runners) and other. Grafana makes a
-- separate alert instance per row, so an alert says which fleet is queueing
-- instead of reporting one max over every runner. GitHub-hosted runners
-- (ubuntu-*, windows-*, xcode-*, linux.24_04.*) are left out: their queues
-- are not ours to fix.
--
-- Two rules read it, both with Teams = pytorch-dev-infra:
--
--   P2  jobs_queued >= 100 AND max_wait_mins >= 60, pending period 30m
--   P1  jobs_queued >= 1000, pending period 30m
--
-- The previous rule fired when any one job had waited 60 minutes, usually a
-- single stuck job rather than a backlog: about 18 times a week. Replaying
-- queue sizes rebuilt from workflow_job every 15 minutes over Sep 3 - Nov 2,
-- 2026, the P2 rule fires about 6 times a week, and the P1 rule 14 times in
-- the 61 days (twice since Sep 29). In the Nov 2 CI SEV
-- (pytorch/pytorch#203130, mt- runners) they fire at 09:30 PT and 12:15 PT;
-- the SEV was opened at 15:52 PT.
SELECT
    multiIf(
        startsWith(machine_type, 'mt-'), 'mt-',
        startsWith(machine_type, 'lf-'), 'lf-',
        position(machine_type, 'windows.') > 0, 'windows',
        'other'
    ) AS runner_fleet,
    sum(machines_queueing) AS jobs_queued,
    max(max_queue_time_mins) AS max_wait_mins
FROM materialized_views.queued_runners_mv
WHERE
    repo = 'pytorch/pytorch'
    -- exclude machines with their own thresholds or notification logic
    AND NOT multiSearchAnyCaseInsensitive(machine_type, [
        'rocm',
        'xpu',
        's390x',
        'b200',
        'h100',
        'macos'
    ])
    -- exclude GitHub-hosted runners
    AND NOT startsWith(machine_type, 'ubuntu-')
    AND NOT startsWith(machine_type, 'windows-')
    AND NOT startsWith(machine_type, 'xcode-')
    AND NOT startsWith(machine_type, 'linux.24_04')
GROUP BY runner_fleet
