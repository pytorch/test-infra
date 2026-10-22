-- Autorevert system activity per time bucket, by action:
--   revert   = a bad commit was reverted
--   restart  = workflows re-run on a suspected-bad commit
--   advisor  = advisory signal only (no action taken)
-- Excludes dry-run events. `commits` is distinct commit_sha touched.
select
    DATE_TRUNC({granularity: String}, ts) as granularity_bucket,
    action,
    count() as events,
    uniqExact(commit_sha) as commits
from
    misc.autorevert_events_v2
where
    repo in {selectedRepos: Array(String)}
    and dry_run = 0
    and ts > {startTime: DateTime64(9)}
    and ts < {stopTime: DateTime64(9)}
group by
    granularity_bucket,
    action
order by
    granularity_bucket asc
