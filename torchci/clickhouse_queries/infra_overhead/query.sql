-- Top-down account-level EC2 cost (list basis), split into non-idle CI / idle / control-plane.
-- provisioned (all EC2 usage x Vantage list) = CI (sum runner_cost) + idle + control-plane.
--   non-idle (CI) = attributed to CI jobs
--   idle         = runner-fleet capacity (classic EC2 + EKS nodes) not running a job
--   control-plane = dedicated base/system nodes (pypi-cache, base nodegroups, mgmt)
-- Account-wide: not affected by the repo / dimension filters above.
with c as (
  select DATE_TRUNC({granularity: String}, date) as b,
         sum(ci_cost) as ci, sum(idle_cost) as idle, sum(control_plane_cost) as cp
  from misc.infra_overhead_daily
  where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
  group by b
)
select granularity_bucket, series, value from (
  select b as granularity_bucket, 'non-idle (CI)' as series, round(ci) as value from c
  union all select b, 'idle (runner fleet)', round(idle) from c
  union all select b, 'control-plane / base', round(cp) from c
)
order by granularity_bucket asc
