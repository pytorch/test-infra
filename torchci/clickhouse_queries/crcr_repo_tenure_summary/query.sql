-- All-repository equivalent of crcr_repo_tenure's l2_since calculation for
-- the CRCR summary. It avoids a separate tenure query for every L3 table row.
SELECT
    downstream_repo AS repo,
    minIf(started_at, downstream_repo_level = 'L2') AS l2_since
FROM
    default.crcr_workflow_job FINAL
WHERE
    started_at > 0
GROUP BY
    repo
