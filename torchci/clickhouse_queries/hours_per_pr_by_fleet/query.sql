-- CI compute-HOURS per PR, split by fleet (OSDC/ciforge mt-* vs Regular EC2 vs GitHub-hosted).
-- Hours are exact (no rate estimate). During the OSDC shadow period both fleets ran the SAME
-- PRs, so comparing the two lines in that window shows OSDC vs EC2 efficiency for identical work.
with
  c as (
    select DATE_TRUNC({granularity: String}, date) as b,
           sum(pr_hours_osdc) as osdc, sum(pr_hours_regular) as regular, sum(pr_hours_github) as github
    from misc.unit_cost_daily
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  ),
  k as (
    select DATE_TRUNC({granularity: String}, date) as b, uniqExactIf(key, kind='pr') as n_pr
    from misc.unit_keys
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  )
select granularity_bucket, fleet, hours_per_pr
from (
    select c.b as granularity_bucket, 'OSDC/ciforge' as fleet, round(osdc / nullIf(n_pr,0), 1) as hours_per_pr
      from c inner join k on c.b=k.b
    union all select c.b, 'Regular EC2', round(regular / nullIf(n_pr,0), 1) from c inner join k on c.b=k.b
    union all select c.b, 'GitHub-hosted', round(github / nullIf(n_pr,0), 1) from c inner join k on c.b=k.b
)
order by granularity_bucket asc
