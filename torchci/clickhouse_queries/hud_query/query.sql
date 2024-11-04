WITH job AS (
    SELECT
        job.head_sha as sha,
        job.name as job_name,
        job.status as status,
        workflow.name as workflow_name,
        job.id as id,
        job.conclusion as conclusion,
        job.html_url as html_url,
        IF(
          {repo: String} = 'pytorch/pytorch',
          CONCAT(
              'https://ossci-raw-job-status.s3.amazonaws.com/log/',
              job.id::String
            ),
          CONCAT(
              'https://ossci-raw-job-status.s3.amazonaws.com/log/',
              {repo: String},
              '/',
              job.id::String
            )
          ) as log_url,
        if(
            job.completed_at = 0,
            null,
            DATE_DIFF('SECOND', job.started_at, job.completed_at)
        ) AS duration_s,
        workflow.repository.'full_name' as repo,
        job.torchci_classification.'line' as line,
        job.torchci_classification.'captures' as captures,
        job.torchci_classification.'line_num' as line_num,
        annotation.annotation as annotation
    FROM
        workflow_job job final
        INNER JOIN workflow_run workflow final on workflow.id = job.run_id
        LEFT JOIN job_annotation annotation final ON job.id = annotation.jobID
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND job.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
        AND workflow.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha in {shas: Array(String)})
        AND workflow.repository.'full_name' = {repo: String}
    -- Removed CircleCI query
)
SELECT
    sha,
    CONCAT(workflow_name, ' / ', job_name) as name,
    id,
    conclusion as conclusion,
    status as status,
    html_url as htmlUrl,
    log_url as logUrl,
    duration_s as durationS,
    repo as repo,
    -- Like commit_jobs_query we need to convert these to arrays
    if(line = '', [ ], [ line ]) AS failureLines,
    if(line_num = 0, [ ], [ line_num ]) AS failureLineNumbers,
    captures as failureCaptures,
    annotation as failureAnnotation
FROM
    job
