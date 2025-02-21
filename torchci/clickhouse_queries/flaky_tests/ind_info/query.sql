-- File location is misleading, this is actually just any failed test, not
-- necessarily flaky.
WITH failed_test_runs AS (
    SELECT
        t.name AS name,
        t.classname AS classname,
        t.file AS file,
        t.invoking_file AS invoking_file,
        t.job_id
    FROM default.failed_test_runs AS t
    WHERE
        t.name = {name: String}
        AND t.classname = {suite: String}
        AND t.file = {file: String}
),

failed_jobs AS (
    SELECT
        j.conclusion AS conclusion,
        j.id AS id,
        j.run_id AS run_id,
        j.name AS name,
        j.html_url AS html_url,
        j.started_at AS started_at,
        tupleElement(j.torchci_classification, 'line') AS line,
        tupleElement(j.torchci_classification, 'line_num') AS line_num,
        tupleElement(j.torchci_classification, 'captures') AS captures,
        j.head_sha AS head_sha
    FROM default.workflow_job AS j
    WHERE
        j.id IN (SELECT t.job_id FROM failed_test_runs t)
)

SELECT DISTINCT
    t.name AS name,
    t.classname AS classname,
    t.file AS file,
    t.invoking_file AS invoking_file,
    j.conclusion AS conclusion,
    j.id AS job_id,
    j.name AS job_name,
    j.html_url AS job_url,
    j.started_at AS job_started_at,
    j.line AS line,
    j.line_num AS line_num,
    j.captures AS captures,
    w.head_branch AS head_branch,
    j.head_sha AS head_sha
FROM failed_jobs AS j
INNER JOIN failed_test_runs AS t ON j.id = t.job_id
INNER JOIN default.workflow_run AS w ON w.id = j.run_id
ORDER BY j.started_at DESC
LIMIT
    {limit: Int32}
