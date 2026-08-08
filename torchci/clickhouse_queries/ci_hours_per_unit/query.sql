-- Average CI compute-hours per commit and per PR, per time bucket. Long format
-- (metric/value) so it can be grouped by `metric` in a time-series panel.
-- commit = distinct head_sha on push events; PR = distinct PR branch on
-- pull_request events. Hours = sum of job wall-clock (completed - started).
with base as (
    select
        DATE_TRUNC({granularity: String}, created_at) as granularity_bucket,
        round(
            sumIf(dateDiff('second', started_at, completed_at), workflow_event = 'push') / 3600
                / nullIf(uniqExactIf(head_sha, workflow_event = 'push'), 0),
            1
        ) as hours_per_commit,
        round(
            sumIf(dateDiff('second', started_at, completed_at), workflow_event = 'pull_request') / 3600
                / nullIf(uniqExactIf(head_branch, workflow_event = 'pull_request'), 0),
            1
        ) as hours_per_pr
    from
        default.workflow_job
    where
        repository_full_name in {selectedRepos: Array(String)}
        and completed_at > started_at
        and created_at > {startTime: DateTime64(9)}
        and created_at < {stopTime: DateTime64(9)}
    group by
        granularity_bucket
)
select granularity_bucket, 'per commit' as metric, hours_per_commit as value from base
union all
select granularity_bucket, 'per PR' as metric, hours_per_pr as value from base
order by granularity_bucket asc
