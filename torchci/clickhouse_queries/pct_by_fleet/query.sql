-- Each fleet's SHARE (% of total inside-PR compute-hours) per time bucket — 100%-stacked view.
with c as (
  select DATE_TRUNC({granularity: String}, date) as b,
    sum(pr_hours_osdc) as o, sum(pr_hours_regular) as r, sum(pr_hours_github) as g,
    nullIf(sum(pr_hours_osdc)+sum(pr_hours_regular)+sum(pr_hours_github), 0) as tot
  from misc.unit_cost_daily
  where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
    and repo in {selectedRepos: Array(String)}
  group by b
)
select granularity_bucket, fleet, value from (
  select b as granularity_bucket, 'OSDC/ciforge' as fleet, round(100*o/tot, 1) as value from c
  union all select b, 'Regular EC2', round(100*r/tot, 1) from c
  union all select b, 'GitHub-hosted', round(100*g/tot, 1) from c
)
order by granularity_bucket asc
