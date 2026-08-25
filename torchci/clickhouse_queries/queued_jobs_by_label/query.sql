--- This query is used by HUD metrics page to get the list of queued jobs grouped by their labels
---
--- For EC2/LF runners: queue time = time in 'queued' status (created_at to now)
--- For ARC runners (labels containing l-): queue time = time in 'queued' status + container
---   initialization time (before actual work starts). Phase 2 captures jobs that
---   are in_progress but still initializing containers (<=2 steps completed).
---   Jobs with a recorded conclusion are excluded to avoid counting stale entries.
---
--- This query additionally reports how many of a machine type's queued jobs
--- look like they belong to a workflow run GitHub abandoned (stale_count /
--- oldest_stale_s). That is ADVISORY only: count and avg_queue_s still cover
--- every queued job exactly as they always have, so no consumer and no reader
--- loses an alarm because the heuristic guessed wrong. See the is_stale
--- definition below for what it can and cannot establish.
WITH possible_queued_jobs as (
    select id, run_id from default.workflow_job where
    created_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
    AND created_at > (CURRENT_TIMESTAMP() - INTERVAL 1 WEEK)
    AND (
        --- EC2/LF: jobs still in queued status
        status = 'queued'
        OR
        --- ARC: jobs in_progress but possibly still initializing containers
        (status = 'in_progress'
         AND conclusion = ''
         AND arrayExists(x -> x LIKE '%l-%', labels))
    )
),
--- Runner pools that are demonstrably serving work: a job created in the last
--- hour asking for this exact label set has since been picked up by a runner.
--- runner_name is the reliable "did this actually start" test — status and
--- started_at both lie on jobs whose webhooks went missing, which is the very
--- population being classified below.
---
--- This is the guard that keeps a genuine outage visible. A pool with no
--- eligible runners, no capacity, or a broken runner group ALSO leaves its jobs
--- untouched and its parent runs frozen, and would otherwise be written off as
--- abandoned exactly when someone needs to see it. Requiring the pool to be
--- alive can only ever REMOVE the stale label, never add one.
---
--- Keyed on the whole `labels` array rather than on the displayed machine_type,
--- because that array is what the job is actually scheduled against;
--- machine_type is one element of it, so two different pools can share one.
--- runner_group_name deliberately plays no part: it is empty while a job is
--- queued and only filled in once a runner takes it, so including it would mean
--- a queued job could never match anything (measured 2026-08-25 — every started
--- ubuntu-24.04 job reads 'GitHub Actions', every queued one reads '').
---
--- Two consequences worth knowing. A job whose label set nothing else has run
--- in the last hour is never called abandoned, so ghosts do linger on very
--- low-volume pools; that is the safe direction. And classification is
--- workload-dependent — an unchanged job can move between live and abandoned
--- as unrelated work enters and leaves the window.
live_runner_pools AS (
    SELECT DISTINCT labels
    FROM default.workflow_job
    WHERE
        created_at > (CURRENT_TIMESTAMP() - INTERVAL 1 HOUR)
        AND runner_name != ''
),
--- EC2/LF runners: existing logic, only jobs in queued status
ec2_queued_jobs AS (
    SELECT
        DATE_DIFF('second', job.created_at, CURRENT_TIMESTAMP()) AS queue_s,
        CONCAT(workflow.name, ' / ', job.name) AS name,
        job.html_url,
        IF(
            LENGTH(job.labels) = 0,
            IF (
                job.runner_group_name IS NOT null
                AND job.runner_group_name != 'Default'
                AND job.runner_group_name != 'GitHub Actions'
                AND job.runner_group_name != ''
                AND job.runner_group_name != 'linux.rocm.gpu.group',
                job.runner_group_name,
                'N/A'
            ),
            IF(LENGTH(job.labels) > 1, job.labels [ 2 ], job.labels [ 1 ])
        ) AS machine_type,
        --- Abandoned run: pytorch/pytorch creates each workflow twice per
        --- ghstack push and the concurrency group cancels the loser seconds
        --- later. When GitHub drops that cancellation the losing run is
        --- orphaned — it stays 'queued' forever and its updated_at never moves
        --- off created_at, because not one of its jobs ever transitioned. Its
        --- jobs then sit here until the 1 WEEK window above ages them out,
        --- which is days of a permanent 5d+ row on the metrics page.
        ---
        --- Three independent things all have to hold, because no one of them
        --- is conclusive on its own:
        ---   1. the run never made any progress at all, and is old enough that
        ---      "not yet" is not an explanation. A run created minutes ago
        ---      also has updated_at = created_at. Measured on the live
        ---      population 2026-08-25, frozen runs are either younger than 6h
        ---      (legitimately waiting; 164 jobs, none queued over 1h) or older
        ---      than 24h (abandoned; 11 jobs, oldest queued 6.8 days) — the
        ---      6h-to-24h band was empty.
        ---   2. this job in particular never started. Without this an
        ---      in_progress ARC job (which arc_queued_jobs deliberately admits
        ---      while containers initialise) could inherit the label from its
        ---      parent's timestamps alone.
        ---   3. the job asks for a non-empty label set that something else has
        ---      run recently — see live_runner_pools above. An empty label
        ---      array carries no pool identity at all, so it is excluded
        ---      rather than matched against whatever else happens to be empty.
        ---
        --- None of that is proof, and the gap is not closable from this data.
        --- A run every one of whose jobs is starving looks identical, and
        --- `labels` is the job's REQUEST, not the pool's identity — GitHub also
        --- matches on runner group and repository access, and runner_group_name
        --- is empty until a runner picks the job up, so it cannot be part of
        --- the key. The one signal that would be conclusive is the completed
        --- duplicate run, and joining workflow_run to itself by head_sha took
        --- 18s against this table versus ~2s for the whole query, which is not
        --- affordable on a panel that refreshes every 5 minutes.
        ---
        --- So this stays ADVISORY. It changes no default: count and avg_queue_s
        --- still cover every queued job, the metrics page still shows them with
        --- their usual red/yellow thresholds and still sorts on them by
        --- default, and no row is hidden, greyed or demoted. A wrong guess
        --- costs a wrong label and nothing else. A reader can sort or filter on
        --- the new column like any other — that is their choice, made visibly
        --- and undone by a click.
        ---
        --- What must not happen is this deciding anything on its own. Resist
        --- wiring it into an automatic filter, a default sort, or an alert
        --- threshold: the moment it picks what an oncaller sees first without
        --- being asked, every limitation above turns into a way to bury a real
        --- outage.
        (
            workflow.updated_at = workflow.created_at
            AND workflow.created_at < (CURRENT_TIMESTAMP() - INTERVAL 6 HOUR)
            AND job.status = 'queued'
            AND job.runner_name = ''
            AND LENGTH(job.steps) = 0
            AND LENGTH(job.labels) > 0
            AND job.labels IN (SELECT labels FROM live_runner_pools)
        ) AS is_stale
    FROM
        default.workflow_job job final
        JOIN default.workflow_run workflow final ON workflow.id = job.run_id
    WHERE
        job.id in (select id from possible_queued_jobs)
        and workflow.id in (select run_id from possible_queued_jobs)
        and workflow.repository. 'full_name' = 'pytorch/pytorch'
        AND job.status = 'queued'
        AND job.created_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
        AND LENGTH(job.steps) = 0
        AND workflow.status != 'completed'
        --- Exclude ARC runners from this path
        AND NOT arrayExists(x -> x LIKE '%l-%', job.labels)
),
--- ARC runners: queued OR in_progress but still initializing containers
arc_queued_jobs AS (
    SELECT
        DATE_DIFF('second', job.created_at, CURRENT_TIMESTAMP()) AS queue_s,
        CONCAT(workflow.name, ' / ', job.name) AS name,
        job.html_url,
        IF(LENGTH(job.labels) > 1, job.labels [ 2 ], job.labels [ 1 ]) AS machine_type,
        --- Same abandoned-run discriminator as ec2_queued_jobs above. Keep the
        --- two textually identical; test/queuedJobsStale.test.ts enforces it.
        (
            workflow.updated_at = workflow.created_at
            AND workflow.created_at < (CURRENT_TIMESTAMP() - INTERVAL 6 HOUR)
            AND job.status = 'queued'
            AND job.runner_name = ''
            AND LENGTH(job.steps) = 0
            AND LENGTH(job.labels) > 0
            AND job.labels IN (SELECT labels FROM live_runner_pools)
        ) AS is_stale
    FROM
        default.workflow_job job final
        JOIN default.workflow_run workflow final ON workflow.id = job.run_id
    WHERE
        job.id in (select id from possible_queued_jobs)
        and workflow.id in (select run_id from possible_queued_jobs)
        and workflow.repository. 'full_name' = 'pytorch/pytorch'
        --- ARC runner detection: labels contain l- pattern
        AND arrayExists(x -> x LIKE '%l-%', job.labels)
        AND workflow.status != 'completed'
        AND job.conclusion = ''
        AND (
            --- Phase 1: still in queued status
            (job.status = 'queued' AND LENGTH(job.steps) = 0)
            OR
            --- Phase 2: picked up by runner but still initializing containers.
            --- Container init is always the first 2 steps (Set up job +
            --- Initialize containers). If only those steps exist, actual
            --- work hasn't started yet. The 10 min cap guards against stale
            --- step data in ClickHouse — the job is either running ok or fails
            --- already if it has less than 2 steps after 10 minutes
            (job.status = 'in_progress'
             AND LENGTH(job.steps) > 0
             AND LENGTH(job.steps) <= 2
             AND job.created_at > (CURRENT_TIMESTAMP() - INTERVAL 10 MINUTE))
        )
)
--- Classify per JOB and then aggregate. Judging a whole machine_type at once
--- would let one suspect job speak for a healthy live queue sharing its name.
---
--- Everything here is additive. count, avg_queue_s, machine_type, time and the
--- row ordering are byte-for-byte what they were, because this query is served
--- unauthenticated at /api/clickhouse/queued_jobs_by_label and out-of-repo
--- consumers cannot be enumerated. The two new columns are the whole change,
--- and nothing acts on them automatically: not the ordering here, and not the
--- metrics page, which sorts on avg_queue_s as it always did.
SELECT
    COUNT(*) AS count,
    --- Misnamed since it was introduced: a MAX, not an average. Left alone for
    --- the same compatibility reason as count.
    MAX(queue_s) AS avg_queue_s,
    COUNTIf(is_stale) AS stale_count,
    MAXIf(queue_s, is_stale) AS oldest_stale_s,
    machine_type,
    CURRENT_TIMESTAMP() AS time
FROM (
    SELECT queue_s, is_stale, machine_type FROM ec2_queued_jobs
    UNION ALL
    SELECT queue_s, is_stale, machine_type FROM arc_queued_jobs
)
GROUP BY
    machine_type
ORDER BY
    count DESC
SETTINGS allow_experimental_analyzer = 1;
