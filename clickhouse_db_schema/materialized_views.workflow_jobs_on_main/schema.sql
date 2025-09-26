-- Table to store workflow jobs on main branch from the last 7 days.
-- Today is used by our alerts to detect which jobs are failing on main.
-- If you want to update the materialize view, just copy/paste everything below.
--   into clickhouse and run it. Dropping and recreating the table is fine, it
--   ensures we don't get out of sync by accident. The next refresh will
--   repopulate the table.
-- You can force an immediate refresh by running:
--   SYSTEM REFRESH VIEW materialized_views.workflow_jobs_on_main_mv;
--   SYSTEM WAIT VIEW materialized_views.workflow_jobs_on_main_mv;

-- If the table already exists, drop it to ensure a fresh start.
DROP TABLE IF EXISTS materialized_views.workflow_jobs_on_main_mv;
DROP TABLE IF EXISTS materialized_views.workflow_jobs_on_main;

-- Create the table to store the materialized view data.
CREATE TABLE materialized_views.workflow_jobs_on_main
(
    head_sha       String,
    workflow_name  String,
    job_name      String,
    commit_time    DateTime64(9),
    status         String,
    conclusion     String,
    commit_message String
)
ENGINE = MergeTree
ORDER BY (workflow_name, job_name, conclusion, commit_time);

-- Create the materialized view to populate the table with relevant data.
CREATE MATERIALIZED VIEW materialized_views.workflow_jobs_on_main_mv
REFRESH EVERY 5 MINUTE
TO materialized_views.workflow_jobs_on_main
AS
SELECT
    j.head_sha,
    j.workflow_name,
    j.name as job_name,
    p.commit_time,
    j.status,
    j.conclusion,
    substring(p.commit_message, 1, 80) AS commit_message
FROM default.workflow_job AS j
JOIN
(
    SELECT
        tupleElement(head_commit, 'id')        AS commit_sha,
        tupleElement(head_commit, 'timestamp') AS commit_time,
        tupleElement(head_commit, 'message')   AS commit_message
    FROM default.push
    WHERE tupleElement(repository, 'full_name') = 'pytorch/pytorch'
      AND ref = 'refs/heads/main'
      AND tupleElement(head_commit, 'timestamp') >= (now() - INTERVAL 7 DAY)
) AS p
    ON p.commit_sha = j.head_sha;
