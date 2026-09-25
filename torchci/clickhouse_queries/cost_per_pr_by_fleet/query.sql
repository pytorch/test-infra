-- Average $ per PR, split by the fleet the PR's CI ran on (OSDC/ciforge mt-* vs regular EC2 vs GitHub-hosted).
-- Same #PRs denominator per bucket; shows where per-PR spend is shifting (e.g. OSDC migration).
with
  c as (
    select DATE_TRUNC({granularity: String}, date) as b,
           sum(pr_cost_osdc) as osdc, sum(pr_cost_regular) as regular, sum(pr_cost_github) as github
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
select granularity_bucket, fleet, avg_cost
from (
    select c.b as granularity_bucket, 'OSDC/ciforge' as fleet, round(osdc / nullIf(n_pr,0), 2) as avg_cost
      from c inner join k on c.b=k.b
    union all select c.b, 'Regular EC2', round(regular / nullIf(n_pr,0), 2) from c inner join k on c.b=k.b
    union all select c.b, 'GitHub-hosted', round(github / nullIf(n_pr,0), 2) from c inner join k on c.b=k.b
)
order by granularity_bucket asc
