-- Drivers behind per-PR cost: PR volume, commits/PR, jobs/PR, compute-hours/PR, effective $/hr.
-- Lets you see WHY $/PR moved (more tests? more PRs? more commits/PR? price/fleet mix?).
with
  k as (
    select DATE_TRUNC({granularity: String}, date) as b,
           uniqExactIf(key, kind='pr') as n_pr, uniqExactIf(key, kind='plain') as n_plain
    from misc.unit_keys
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  ),
  c as (
    select DATE_TRUNC({granularity: String}, date) as b,
           sum(pr_cost) as prc, sum(pr_jobs) as jobs, sum(pr_hours) as hours
    from misc.unit_cost_daily
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  )
select granularity_bucket, metric, value
from (
    select k.b as granularity_bucket, '# PRs' as metric, toFloat64(n_pr) as value from k
    union all select k.b, 'commits / PR', round(n_plain / nullIf(n_pr,0), 2) from k
    union all select c.b, 'jobs / PR', round(jobs / nullIf(n_pr,0), 1) from c inner join k on c.b=k.b
    union all select c.b, 'CI hours / PR', round(hours / nullIf(n_pr,0), 1) from c inner join k on c.b=k.b
    union all select c.b, '$ / hr (effective)', round(prc / nullIf(hours,0), 3) from c
    union all select c.b, '$ / PR', round(prc / nullIf(n_pr,0), 2) from c inner join k on c.b=k.b
)
order by granularity_bucket asc
