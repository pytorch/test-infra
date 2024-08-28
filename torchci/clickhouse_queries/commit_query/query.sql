-- !!! Query is not converted to CH syntax yet.  Delete this line when it gets converted
SELECT
    workflow.head_commit as commit
FROM
   workflow_run workflow
WHERE
    workflow.head_commit.id = :sha
LIMIT
    1
