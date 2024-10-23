SELECT
    DATE_TRUNC(
        {granularity: String},
        workflow.created_at
    ) AS granularity_bucket,
    workflow.name,
    COUNT(*) as count
FROM
    default.workflow_run workflow final
WHERE
    -- optimization to make query faster
    workflow.id in (
        select id from materialized_views.workflow_run_by_created_at
        where created_at >= {startTime: DateTime64(9)}
        AND created_at <= {stopTime: DateTime64(9)}
    )
    -- re check for final
    and workflow.created_at >= {startTime: DateTime64(9)}
    AND workflow.created_at <= {stopTime: DateTime64(9)}
    AND workflow.name IN (
        'pull',
        'trunk',
        'nightly',
        'periodic',
        'inductor',
        'inductor-periodic',
        'inductor-A100-perf-compare',
        'inductor-A100-perf-nightly',
        'inductor-cu124',
        'rocm',
        'inductor-rocm'
    )
    AND workflow.repository.'full_name' like {repo: String}
GROUP BY
    granularity_bucket,
    workflow.name
ORDER BY
    count DESC
