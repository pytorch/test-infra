-- Materialized view to track queuing runners and their wait times.
-- This view monitors jobs that have been queued for more than 5 minutes
-- and provides insights into machine types and queue times.
-- If you want to update the materialize view, just copy/paste everything below
--   into clickhouse and run it. Dropping and recreating the table is fine, it
--   ensures we don't get out of sync by accident. The next refresh will
--   repopulate the table.
-- You can force an immediate refresh by running:
--   SYSTEM REFRESH VIEW materialized_views.queued_runners_mv;
--   SYSTEM WAIT VIEW materialized_views.queued_runners_mv;

-- If the table already exists, drop it to ensure a fresh start.
DROP TABLE IF EXISTS materialized_views.queued_runners_mv;
DROP TABLE IF EXISTS materialized_views.queued_runners;

-- Create the table to store the materialized view data.
CREATE TABLE materialized_views.queued_runners
(
    machine_type String,
    repo String,
    machines_queueing UInt64,
    max_queue_time_mins UInt64
)
ENGINE = MergeTree
ORDER BY (machine_type, repo);

-- Create the materialized view to populate the table with relevant data.
CREATE MATERIALIZED VIEW materialized_views.queued_runners_mv
REFRESH EVERY 1 MINUTE
TO materialized_views.queued_runners
AS
WITH
  possible_queued_jobs AS (
    SELECT id, run_id
    FROM default.workflow_job
    WHERE status = 'queued'
      AND created_at < (now() - INTERVAL 5 MINUTE) -- 5 mins is a normal wait time for a runner to be spun up
      AND created_at > (now() - INTERVAL 1 WEEK)
  ),

  queued_jobs AS (
    SELECT
      dateDiff('second', job.created_at, now()) AS queue_s,
      job.repository_full_name AS repo,
      if(
        length(job.labels) = 0,
        if(
          job.runner_group_name IS NOT NULL
          AND job.runner_group_name NOT IN ('Default','GitHub Actions','','linux.rocm.gpu.group'),
          job.runner_group_name,
          'N/A'
        ),
        if(length(job.labels) > 1, job.labels[2], job.labels[1])
      ) AS machine_type
    FROM default.workflow_job AS job FINAL
    INNER JOIN default.workflow_run AS workflow FINAL ON workflow.id = job.run_id
    WHERE job.id IN (SELECT id FROM possible_queued_jobs)
      AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
      AND job.status = 'queued'
      AND length(job.steps) = 0
      AND workflow.status != 'completed'
      AND (
        job.repository_full_name like 'pytorch/%'
        OR job.repository_full_name like 'meta-pytorch/%'
      )
  ),

  per_type AS (
    SELECT
      machine_type,
      repo,
      count() AS machines_queueing,
      ROUND(max(queue_s) / 60) AS max_queue_time_mins
    FROM queued_jobs
    GROUP BY machine_type, repo
  )

SELECT *
FROM per_type
/* filter out weird GH API bugs */
WHERE machines_queueing > 5;
