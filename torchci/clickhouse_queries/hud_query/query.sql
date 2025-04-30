WITH job AS (
    SELECT
        job.head_sha as sha,
        job.name as job_name,
        job.workflow_name as workflow_name,
        job.id as id,
        job.status as status,
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
        job.repository_full_name as repo,
        job.torchci_classification.'line' as line,
        job.torchci_classification.'captures' as captures,
        job.torchci_classification.'line_num' as line_num,
        annotation.annotation as annotation
    FROM
        workflow_job job final
        LEFT JOIN job_annotation annotation final ON job.id = annotation.jobID
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND job.workflow_event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND job.workflow_event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND job.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
        AND job.repository_full_name = {repo: String}
        AND job.workflow_name != 'Upload test stats while running' -- Continuously running cron job that cancels itself to avoid running concurrently
    -- Removed CircleCI query
)
SELECT
    sha,
    CONCAT(workflow_name, ' / ', job_name) as name,
    id,
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
    annotation as failureAnnotation
FROM
    job
