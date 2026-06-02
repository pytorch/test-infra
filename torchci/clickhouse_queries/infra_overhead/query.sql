-- Top-down account-level EC2 cost (list basis), split into attributed CI vs overhead/idle.
-- provisioned (all EC2 usage x Vantage list) = attributed CI (sum runner_cost) + overhead.
-- Overhead = idle/min_available warm runners, k8s control plane, base infra, non-CI EC2.
-- Account-wide: not affected by the repo / dimension filters above.
with c as (
  select DATE_TRUNC({granularity: String}, date) as b,
         sum(ci_cost) as ci, sum(overhead_cost) as ov
  from misc.infra_overhead_daily
  where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
  group by b
)
select granularity_bucket, series, value from (
  select b as granularity_bucket, 'attributed CI' as series, round(ci) as value from c
  union all select b, 'overhead / idle', round(ov) from c
)
order by granularity_bucket asc
