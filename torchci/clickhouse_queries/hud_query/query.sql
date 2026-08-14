WITH job AS (
    SELECT
        job.head_sha as sha,
        job.name as job_name,
        job.workflow_name as workflow_name,
        job.id as id,
        job.run_id as workflowId,
        job.status as status,
        job.conclusion_kg as conclusion,
        job.html_url as html_url,
        job.log_url as log_url,
        if(
            job.completed_at = 0,
            null,
            DATE_DIFF('SECOND', job.started_at, job.completed_at)
        ) AS duration_s,
        job.repository_full_name as repo,
        job.torchci_classification_kg.'line' as line,
        job.torchci_classification_kg.'captures' as captures,
        job.torchci_classification_kg.'line_num' as line_num,
        annotation.annotation as annotation,
        -- Provenance for the rows the restart clause below now admits: mark a job that came from
        -- an autorevert restart run, so the tooltip can say so instead of leaving an unexplained
        -- green cell for a job the commit never naturally ran.
        -- NULL rather than '' on purpose: fetchHud strips nulls before shipping the grid, so this
        -- costs nothing on the ordinary jobs that are the vast majority of rows.
        if(
            job.workflow_event = 'workflow_dispatch'
            AND job.head_branch LIKE 'trunk/%',
            'autorevert',
            NULL
        ) AS restart_source,
        tupleElement(restart_run.latest, 1) as restart_actor_login,
        tupleElement(restart_run.latest, 2) as restart_triggering_actor_login,
        tupleElement(restart_run.latest, 3) as restart_run_attempt
    FROM
        workflow_job job final
        LEFT JOIN job_annotation annotation final ON job.id = annotation.jobID
        -- workflow_job carries no actor column, so the dispatching identity has to come from
        -- workflow_run. Scoped to restart runs for the requested shas only, and keyed through the
        -- same materialized view commit_jobs_query uses so this is a primary-key lookup instead of
        -- a scan on head_sha (which is not in workflow_run's sorting key).
        -- GROUP BY + argMax rather than FINAL: workflow_run is a ReplacingMergeTree with no version
        -- column, and FINAL on it measured ~5.6s against ~0.7s for this shape on the same input.
        -- run_attempt is monotonic per run, so argMax also expresses what we actually want here --
        -- the latest attempt -- which FINAL alone does not guarantee.
        LEFT JOIN (
            SELECT
                id,
                -- ONE argMax over a tuple rather than three separate ones: independent argMax calls
                -- may resolve their tie differently and report an actor from one physical row with a
                -- triggering actor from another. Ordering by run_attempt takes the latest attempt.
                argMax(
                    (actor.'login', triggering_actor.'login', run_attempt),
                    run_attempt
                ) AS latest
            FROM workflow_run
            WHERE
                id in (
                    select id from materialized_views.workflow_run_by_head_sha
                    where head_sha in {shas: Array(String)}
                )
                -- That materialized view is keyed on head_sha ALONE (its only columns are id and
                -- head_sha), so it can return a run id belonging to a different repo that shares the
                -- sha -- a fork, most obviously. Constrain the repo here, since the MV cannot.
                AND repository.'full_name' = {repo: String}
                AND event = 'workflow_dispatch'
                AND head_branch LIKE 'trunk/%'
            GROUP BY id
        ) restart_run ON restart_run.id = job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND job.workflow_name not in (
            'Upload test stats',
            'Validate and merge PR',
            'Upload torch dynamo performance stats',
            'Revert merged PR'
        )  -- Should be filtered out by the workflow_event filters, but workflow_event takes some time to populate
        AND job.workflow_event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND job.workflow_event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND NOT (job.workflow_event = 'workflow_dispatch' AND job.head_branch LIKE 'trunk/%' AND job.conclusion_kg != 'success') -- Autorevert restart jobs count only when they PASSED: fetchHud's failedPreviousRun can label a success that failed before ("F", flaky), but has no way to label a restart that failed, is still running, or was skipped by the dispatch filter
        AND job.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
        AND job.repository_full_name = {repo: String}
        AND job.workflow_name != 'Upload test stats while running' -- Continuously running cron job that cancels itself to avoid running concurrently
    -- Removed CircleCI query
)
SELECT
    sha,
    CONCAT(workflow_name, ' / ', job_name) as name,
    id,
    workflowId,
    multiIf(
        conclusion = ''
        and status = 'queued' ,
        'queued',
        conclusion = '',
        'pending',
        conclusion
    ) as conclusion,
    status as status,
    html_url as htmlUrl,
    log_url as logUrl,
    duration_s as durationS,
    repo as repo,
    -- Like commit_jobs_query we need to convert these to arrays
    if(line = '', [ ], [ line ]) AS failureLines,
    if(line_num = 0, [ ], [ line_num ]) AS failureLineNumbers,
    captures as failureCaptures,
    annotation as failureAnnotation,
    restart_source as restartSource,
    -- Every provenance field below is gated on restart_source, so none can ever appear on a job the
    -- badge does not also mark. The two sides are derived independently -- the badge from
    -- workflow_job, the identity from workflow_run -- and nothing guarantees they agree under
    -- ingestion lag. The reverse case (badge present, identity missing) stays possible and renders
    -- fine, since each field is conditional in the tooltip.
    -- An unmatched LEFT JOIN also yields the column default ('' / 0) rather than NULL, so normalize:
    -- fetchHud strips only nulls, and an empty string would ship on every ordinary job and make
    -- "field is present" a false test for "this job is a restart".
    if(restart_source IS NULL, NULL, nullIf(restart_actor_login, '')) as restartDispatchedBy,
    -- Only meaningful when it differs: triggering_actor equals the actor on a first attempt, and
    -- names whoever re-ran the run on later ones. Collapsing the two would hide a human re-running
    -- a bot's restart.
    if(
        restart_source IS NOT NULL
        AND restart_triggering_actor_login != ''
        AND restart_triggering_actor_login != restart_actor_login,
        restart_triggering_actor_login,
        NULL
    ) as restartRerunBy,
    -- Deliberately NOT called runAttempt: commit_jobs_query already ships that name with different
    -- semantics (the JOB's run_attempt), and the HUD page reads it at
    -- pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]].tsx as `cr.run_attempt >
    -- (existing.runAttempt ?? 0)` when merging crcr rows. That comparison relies on the field being
    -- undefined in the HUD path today, so populating it here would silently change which job data
    -- wins those cells.
    if(restart_source IS NULL, NULL, nullIf(restart_run_attempt, 0)) as restartRunAttempt
FROM
    job
