-- "Jobs are Queued - autoscaled-machines" alerts.
--
-- One row per fleet: mt-, lf-, windows, other. Grafana alerts per row, so
-- the alert names the fleet. GitHub-hosted runners are skipped.
--
-- Rules (Teams = pytorch-dev-infra, pending period 30m):
--   P2: jobs_queued >= 100 AND max_wait_mins >= 60
--   P1: jobs_queued >= 1000
--
-- Over Sep 3 - Nov 2, 2026: P2 fires ~6 times a week (the old rule ~18).
-- P1 fires 14 times, and would have caught the Nov 2 SEV
-- (pytorch/pytorch#203130) 3.6 hours before it was opened.
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
