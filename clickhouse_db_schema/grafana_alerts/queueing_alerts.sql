-- "Jobs are Queued - autoscaled-machines" alerts.
--
-- Two queries, A and B, each with one row per fleet: mt-, lf-, windows,
-- other. Grafana alerts per row and joins A and B on runner_fleet, so the
-- alert names the fleet. GitHub-hosted runners are skipped. Grafana needs
-- one number per query, so these replace the old max_queue_size and
-- max_queue_time_mins queries in the same rule.
--
-- Rules (Teams = pytorch-dev-infra, pending period 30m):
--   P2: $A >= 100 && $B >= 60
--   P1: $A >= 1000
--
-- B is the longest wait anywhere in the fleet, so it can come from a
-- different runner type than most of A. The view drops runner types with
-- 5 or fewer queued jobs, so A runs slightly low.
--
-- Over Sep 3 - Nov 2, 2026: P2 fires ~6 times a week (the old rule ~18).
-- P1 fires 14 times, and would have caught the Nov 2 SEV
-- (pytorch/pytorch#203130) 3.6 hours before it was opened.

-- A: jobs_queued
SELECT
    multiIf(
        startsWith(machine_type, 'mt-'), 'mt-',
        startsWith(machine_type, 'lf-'), 'lf-',
        position(machine_type, 'windows.') > 0, 'windows',
        'other'
    ) AS runner_fleet,
    sum(machines_queueing) AS jobs_queued
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
GROUP BY runner_fleet;

-- B: max_wait_mins
SELECT
    multiIf(
        startsWith(machine_type, 'mt-'), 'mt-',
        startsWith(machine_type, 'lf-'), 'lf-',
        position(machine_type, 'windows.') > 0, 'windows',
        'other'
    ) AS runner_fleet,
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
GROUP BY runner_fleet;
