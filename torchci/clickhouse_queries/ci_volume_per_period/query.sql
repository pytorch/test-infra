-- Number of commits (push-triggered, distinct head_sha) and PRs (distinct PR
-- branch on pull_request events) that ran CI, per time bucket. Long format
-- (metric/value) so it can be grouped by `metric` in a time-series panel.
with base as (
    select
        DATE_TRUNC({granularity: String}, created_at) as granularity_bucket,
        uniqExactIf(head_sha, workflow_event = 'push') as commits,
        uniqExactIf(head_branch, workflow_event = 'pull_request') as prs
    from
        default.workflow_job
    where
        repository_full_name in {selectedRepos: Array(String)}
        and created_at > {startTime: DateTime64(9)}
        and created_at < {stopTime: DateTime64(9)}
    group by
        granularity_bucket
)
select granularity_bucket, 'commits' as metric, commits as value from base
union all
select granularity_bucket, 'PRs' as metric, prs as value from base
order by granularity_bucket asc
