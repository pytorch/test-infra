--- This query is used by the AWS autoscalers to scale up runner types that
--- have had jobs waiting for them for a significant period of time.
---
--- This query returns the number of jobs per runner type that have been
--- queued for too long, which the autoscalers use to determine how many
--- additional runners to spin up.
---
--- Optimization notes:
---   * `FINAL` on workflow_job was the main memory hog (ReplacingSorted across
---     all parts over a multi-day window). It is replaced with a manual
---     ReplacingMergeTree dedup via `LIMIT 1 BY id ORDER BY _inserted_at DESC`,
---     scoped to the candidate id set from `possible_queued_jobs`.
---   * The workflow_run filters (status != 'completed', org/repo) are pushed
---     into a CTE that runs before the JOIN so the right side shrinks to a
---     handful of rows.
---   * `runnerLabels` is an optional Array(String) filter. When empty (the
---     default), the result matches the previous behavior — callers that read
---     the full aggregate (scale-up-chron lambda) are unaffected.

WITH possible_queued_jobs AS (
    --- Candidate (id, run_id) pairs that have at least one 'queued' row in the
    --- time window. We don't need FINAL here: the manual dedup below confirms
    --- each id's latest state is actually 'queued'.
    SELECT DISTINCT
        id,
        run_id
    FROM default.workflow_job
    WHERE
        status = 'queued'
        AND created_at < (
        -- Only consider jobs that have been queued for a significant period of time
            CURRENT_TIMESTAMP() - toIntervalMinute({queuedThresholdMinutes: Int64})
        )
        AND created_at > (
        -- Queued jobs are automatically cancelled after this long. Any allegedly pending
        -- jobs older than this are actually bad data
            CURRENT_TIMESTAMP() - toIntervalDay({maxAgeDays: Int64})
        )
),

latest_jobs AS (
    --- Manual ReplacingMergeTree dedup. Cheaper than global FINAL because we
    --- only read parts that contain candidate ids.
    SELECT
        id,
        run_id,
        status,
        created_at,
        labels,
        steps,
        name,
        html_url
    FROM default.workflow_job
    WHERE id IN (SELECT id FROM possible_queued_jobs)
    ORDER BY id, _inserted_at DESC
    LIMIT 1 BY id
),

latest_workflows AS (
    --- Pre-filter workflow_run to non-completed runs in the requested orgs/repo
    --- before the JOIN so the right side is tiny.
    SELECT
        id,
        name,
        repository.owner.login AS org,
        repository.name AS repo
    FROM default.workflow_run FINAL
    WHERE
        id IN (SELECT run_id FROM possible_queued_jobs)
        AND status != 'completed'
        AND repository.owner.login IN {orgs: Array(String)}
        AND ({repo: String} = '' OR repository.name = {repo: String})
),

queued_jobs AS (
    SELECT
        DATE_DIFF(
            'minute',
            job.created_at,
            CURRENT_TIMESTAMP()
        ) AS queue_m,
        workflow.org AS org,
        workflow.repo AS repo,
        CONCAT(workflow.name, ' / ', job.name) AS name,
        job.html_url,
        IF(
            LENGTH(job.labels) = 0,
            'N/A',
            IF(
                LENGTH(job.labels) > 1,
                job.labels[2],
                job.labels[1]
            )
        ) AS runner_label
    FROM latest_jobs AS job
    JOIN latest_workflows AS workflow ON workflow.id = job.run_id
    WHERE
        job.status = 'queued'
        /* These two conditions are workarounds for GitHub's broken API. Sometimes */
        /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
        /* detect this by looking at whether any steps executed (if there were, */
        /* obviously the job started running), and whether the workflow was marked as */
        /* complete (workflow.status filter is in latest_workflows above) */
        AND LENGTH(job.steps) = 0
)

SELECT
    runner_label,
    org,
    repo,
    count(*) AS num_queued_jobs,
    min(queue_m) AS min_queue_time_minutes,
    max(queue_m) AS max_queue_time_minutes
FROM queued_jobs
WHERE
    --- Optional caller-side filter. Empty array (the default) preserves the
    --- previous behavior of returning all runner labels.
    length({runnerLabels: Array(String)}) = 0
    OR runner_label IN {runnerLabels: Array(String)}
GROUP BY runner_label, org, repo
ORDER BY max_queue_time_minutes DESC
SETTINGS allow_experimental_analyzer = 1;
