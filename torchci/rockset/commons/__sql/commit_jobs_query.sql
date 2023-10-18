-- This query is used by HUD commit and pull request pages to get all jobs belong
-- to specific commit hash. They can then be displayed on those pages.
WITH job AS (
  SELECT
    job._event_time AS time,
    workflow.head_sha AS sha,
    job.name AS job_name,
    workflow.name AS workflow_name,
    job.id,
    workflow.id AS workflow_id,
    workflow.artifacts_url AS github_artifact_url,
    job.conclusion,
    job.html_url,
    IF(
      : repo = 'pytorch/pytorch',
      CONCAT(
        'https://ossci-raw-job-status.s3.amazonaws.com/log/',
        CAST(job.id AS string)
      ),
      CONCAT(
        'https://ossci-raw-job-status.s3.amazonaws.com/log/',
        : repo,
        '/',
        CAST(job.id AS string)
      )
    ) AS log_url,
    DATE_DIFF(
      'SECOND',
      job._event_time,
      PARSE_TIMESTAMP_ISO8601(job.started_at)
    ) AS queue_time_s,
    DATE_DIFF(
      'SECOND',
      PARSE_TIMESTAMP_ISO8601(job.started_at),
      PARSE_TIMESTAMP_ISO8601(job.completed_at)
    ) AS duration_s,
    job.torchci_classification.line,
    job.torchci_classification.captures,
    job.torchci_classification.line_num,
    job.runner_name AS runner_name,
  FROM
    workflow_job job
    INNER JOIN workflow_run workflow ON workflow.id = job.run_id
  WHERE
    job.name != 'ciflow_should_run'
    AND job.name != 'generate-test-matrix'
    AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
    AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
    AND workflow.head_sha = : sha
    AND job.head_sha = : sha
    AND workflow.repository.full_name = : repo
  UNION
    -- Handle CircleCI
    -- IMPORTANT: this needs to have the same order AS the query above
  SELECT
    job._event_time AS time,
    job.pipeline.vcs.revision AS sha,
    -- Swap workflow and job name for consistency with GHA naming style.
    job.workflow.name AS job_name,
    job.job.name AS workflow_name,
    job.job.number AS id,
    null AS workflow_id,
    null AS github_artifact_id,
    CASE
      WHEN job.job.status = 'failed' THEN 'failure'
      WHEN job.job.status = 'canceled' THEN 'cancelled'
      ELSE job.job.status
    END AS conclusion,
    -- cirleci doesn't provide a url, piece one together out of the info we have
    CONCAT(
      'https://app.circleci.com/pipelines/github/',
      : repo,
      '/',
      CAST(job.pipeline.number AS string),
      '/workflows/',
      job.workflow.id,
      '/jobs/',
      CAST(job.job.number AS string)
    ) AS html_url,
    -- logs aren't downloaded currently, just reuse html_url
    html_url AS log_url,
    null AS queue_time_s,
    -- for circle ci, the event time comes after the end time, so its not reliable for queueing
    DATE_DIFF(
      'SECOND',
      PARSE_TIMESTAMP_ISO8601(job.job.started_at),
      PARSE_TIMESTAMP_ISO8601(job.job.stopped_at)
    ) AS duration_s,
    -- Classifications not yet supported
    null,
    null,
    null,
    -- Don't care about runner name from CircleCI
    null AS runner_name,
  FROM
    circleci.job job
  WHERE
    job.pipeline.vcs.revision = : sha
    AND CONCAT(
      job.organization.name, '/', job.project.name
    ) = : repo
)
SELECT
  sha,
  workflow_name AS workflowName,
  job_name AS jobName,
  CONCAT(workflow_name, ' / ', job_name) AS name,
  CAST(id AS string) AS id,
  CAST(workflow_id AS string) AS workflowId,
  github_artifact_url AS githubArtifactUrl,
  CASE
    WHEN conclusion IS NULL THEN 'pending'
    ELSE conclusion
  END AS conclusion,
  html_url AS htmlUrl,
  log_url AS logUrl,
  duration_s AS durationS,
  queue_time_s AS queueTimeS,
  line AS failureLine,
  line_num AS failureLineNumber,
  captures AS failureCaptures,
  runner_name AS runnerName,
  time,
FROM
  job
ORDER BY
  name,
  time DESC