-- This query is used by HUD commit and pull request pages to get all jobs belong
-- to specific commit hash. They can then be displayed on those pages.
-- Based off of https://github.com/pytorch/test-infra/blob/c84f2b91cd104d3bbff5d99c4459059119050b95/torchci/rockset/commons/__sql/commit_jobs_query.sql#L1
-- CircleCI has been removed
WITH job AS (
    SELECT
        job.started_at AS time,
        workflow.head_sha AS sha,
        job.name AS job_name,
        workflow.name AS workflow_name,
        job.id,
        workflow.id AS workflow_id,
        workflow.artifacts_url AS github_artifact_url,
        multiIf(
            job.conclusion_kg = ''
            and status = 'queued' ,
            'queued',
            job.conclusion_kg = '',
            'pending',
            job.conclusion_kg
        ) as conclusion,
        job.html_url,
        job.log_url AS log_url,
        if(
            job.started_at = 0,
            0,
            DATE_DIFF('SECOND', job.created_at, job.started_at)
        ) AS queue_time_s,
        if(
            job.completed_at = 0,
            0,
            DATE_DIFF('SECOND', job.started_at, job.completed_at)
        ) AS duration_s,
        job.torchci_classification_kg.'line' as line,
        job.torchci_classification_kg.'captures' as captures,
        job.torchci_classification_kg.'line_num' as line_num,
        job.torchci_classification_kg.'context' as context,
        job.runner_name AS runner_name,
        workflow.head_commit. 'author'.'email' AS authorEmail,
        job.run_attempt AS run_attempt,
        -- Origin of the run, so the workflow picker can say what it is offering instead of a bare
        -- numeric id. Same multiIf as hud_query's run_origin on purpose: one run must not read two
        -- different ways on the grid and on this page. A plain push stays NULL -- it is the
        -- overwhelming majority and the default reading.
        multiIf(
            workflow.event = 'workflow_dispatch'
            AND workflow.head_branch LIKE 'trunk/%',
            'autorevert',
            job.run_attempt > 1,
            'retry',
            workflow.event = 'push',
            NULL,
            workflow.event
        ) AS run_origin,
        -- Who ORIGINALLY dispatched an autorevert restart. This query already joins workflow_run
        -- for the run-level event, branch, head_sha and name, and workflow_run.actor is invariant
        -- across re-run attempts -- so the row FINAL selects is sufficient here. hud_query starts
        -- from workflow_job and additionally needs the latest triggering_actor and run_attempt,
        -- which is why it pays for a separate grouped workflow_run lookup; FINAL would NOT be
        -- sufficient for those. NULL for anything that is not a restart.
        if(
            workflow.event = 'workflow_dispatch'
            AND workflow.head_branch LIKE 'trunk/%',
            nullIf(workflow.actor. 'login', ''),
            NULL
        ) AS restart_actor_login
    FROM
        workflow_job job final
        INNER JOIN workflow_run workflow final ON workflow.id = job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        -- KNOWN DIVERGENCE FROM hud_query, deliberate. hud_query no longer filters restarts by
        -- conclusion at all: it admits every run and lets mergeCellRuns decide the cell
        -- issuer-agnostically, so a restart that failed makes a passing cell render flaky instead of
        -- vanishing. This surface cannot do that yet -- fetchCommit dedups by newest id and has no
        -- flaky marker to render, so admitting a non-success restart here would silently REPLACE the
        -- natural conclusion rather than combine with it. Until the commit page can express a flaky
        -- result, the success-only filter stays, and the grid and the commit page will disagree about
        -- a commit whose restart failed.
        AND NOT (workflow.event = 'workflow_dispatch' AND workflow.head_branch LIKE 'trunk/%' AND job.conclusion_kg != 'success')
        AND workflow.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha = {sha: String})
        AND (
            {workflowId: Int64} = 0
            OR workflow.id = {workflowId: Int64} -- If a specific workflow ID is provided, filter by it
        )
        AND (
            {runAttempt: Int64} = 0
            OR job.run_attempt = {runAttempt: Int64} -- If a specific run attempt
        )
        AND job.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha = {sha: String})
        AND workflow.repository. 'full_name' = {repo: String } --         UNION
        AND workflow.name != 'Upload test stats while running' -- Continuously running cron job that cancels itself to avoid running concurrently
    UNION ALL
    SELECT
        workflow.created_at AS time,
        workflow.head_sha AS sha,
        workflow.name AS job_name,
        'Workflow Startup Failure' AS workflow_name,
        workflow.id,
        0 AS workflow_id,
        workflow.artifacts_url AS github_artifact_url,
        if(
            workflow.conclusion = ''
            and workflow.status = 'queued',
            'failure',
            workflow.conclusion
        ) as conclusion,
        workflow.html_url,
        '' AS log_url,
        DATE_DIFF(
            'SECOND',
            workflow.created_at,
            workflow.run_started_at
        ) AS queue_time_s,
        0 AS duration_s,
        '' as line,
        [ ] as captures,
        0 as line_num,
        [ ] as context,
        '' AS runner_name,
        workflow.head_commit.author.email AS authorEmail,
        workflow.run_attempt as run_attempt,
        -- Same two columns as the branch above, because a UNION ALL needs matching shapes. These
        -- rows carry workflow_id = 0, which fetchCommit normalizes to null and getWorkflowIdsByName
        -- then filters out, so a startup-failure pseudo-row never reaches the picker -- they are
        -- projected for the union, not for the dropdown.
        multiIf(
            workflow.event = 'workflow_dispatch'
            AND workflow.head_branch LIKE 'trunk/%',
            'autorevert',
            workflow.run_attempt > 1,
            'retry',
            workflow.event = 'push',
            NULL,
            workflow.event
        ) AS run_origin,
        if(
            workflow.event = 'workflow_dispatch'
            AND workflow.head_branch LIKE 'trunk/%',
            nullIf(workflow.actor. 'login', ''),
            NULL
        ) AS restart_actor_login
    FROM
        workflow_run workflow final
    WHERE
        workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND NOT (workflow.event = 'workflow_dispatch' AND workflow.head_branch LIKE 'trunk/%' AND workflow.conclusion != 'success') -- Autorevert restart runs count only when they PASSED. This branch maps a still-queued run to 'failure', so admitting a restart here would put a red "Workflow Startup Failure / trunk" box on the commit page for the whole queue window
        AND workflow.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha = {sha: String})
        AND (
            {workflowId: Int64} = 0
            OR workflow.id = {workflowId: Int64} -- If a specific workflow ID is provided, filter by it
        )
        AND (
            {runAttempt: Int64} = 0
            OR workflow.run_attempt = {runAttempt: Int64} -- If a specific run attempt is provided, filter by it
        )
        AND workflow.repository.full_name = {repo: String }
        AND workflow.name != 'Upload test stats while running' -- Continuously running cron job that cancels itself to avoid running concurrently
)
SELECT
    sha,
    workflow_name AS workflowName,
    job_name AS jobName,
    CONCAT(workflow_name, ' / ', job_name) AS name,
    id AS id,
    workflow_id AS workflowId,
    github_artifact_url AS githubArtifactUrl,
    if(conclusion = '', 'pending', conclusion) as conclusion,
    html_url AS htmlUrl,
    log_url AS logUrl,
    duration_s AS durationS,
    queue_time_s AS queueTimeS,
    -- Convert to arrays
    if(line = '', [ ], [ line ]) AS failureLines,
    if(line_num = 0, [ ], [ line_num ]) AS failureLineNumbers,
    captures AS failureCaptures,
    context AS failureContext,
    runner_name AS runnerName,
    authorEmail,
    time,
    run_attempt AS runAttempt,
    run_origin AS runOrigin,
    restart_actor_login AS restartDispatchedBy
FROM
    job
ORDER BY
    name,
    time DESC
