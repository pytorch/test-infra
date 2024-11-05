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
        job.conclusion,
        job.html_url,
        IF(
            {repo: String } = 'pytorch/pytorch',
            CONCAT(
                'https://ossci-raw-job-status.s3.amazonaws.com/log/',
                job.id:: String
            ),
            CONCAT(
                'https://ossci-raw-job-status.s3.amazonaws.com/log/',
                {repo: String },
                '/',
                job.id:: String
            )
        ) AS log_url,
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
        job.torchci_classification.line as line,
        job.torchci_classification.captures as captures,
        job.torchci_classification.line_num as line_num,
        job.torchci_classification.context as context,
        job.runner_name AS runner_name,
        workflow.head_commit. 'author'.'email' AS authorEmail
    FROM
        workflow_job job final
        INNER JOIN workflow_run workflow final ON workflow.id = job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND workflow.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha = {sha: String})
        AND job.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha = {sha: String})
        AND workflow.repository. 'full_name' = {repo: String } --         UNION
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
        workflow.head_commit.author.email AS authorEmail
    FROM
        workflow_run workflow final
    WHERE
        workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND workflow.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha = {sha: String})
        AND workflow.repository.full_name = {repo: String }
)
SELECT
    sha,
    workflow_name AS workflowName,
    job_name AS jobName,
    CONCAT(workflow_name, ' / ', job_name) AS name,
    id AS id,
    workflow_id AS workflowId,
    github_artifact_url AS githubArtifactUrl,
    multiIf(
        workflow.conclusion = ''
        and workflow.status = 'queued',
        'queued',
        workflow.conclusion = '',
        'pending',
        workflow.conclusion
    ) as conclusion,
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
FROM
    job
ORDER BY
    name,
    time DESC
