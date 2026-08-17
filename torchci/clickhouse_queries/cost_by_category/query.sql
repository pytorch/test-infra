-- pytorch/pytorch CI cost by category, per time bucket (for a stacked chart).
with c as (
  select DATE_TRUNC({granularity: String}, date) as b,
    sum(pr_cost) as pr, sum(main_cost) as mn, sum(nightly_cost) as ni,
    sum(periodic_cost) as pe, sum(benchmark_cost) as be, sum(other_cost) as ot
  from misc.unit_cost_daily
  where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
    and repo in {selectedRepos: Array(String)}
  group by b
)
select granularity_bucket, category, value from (
  select b as granularity_bucket, 'inside PR' as category, round(pr) as value from c
  union all select b, 'after merge', round(mn) from c
  union all select b, 'nightly (builds)', round(ni) from c
  union all select b, 'periodic', round(pe) from c
  union all select b, 'benchmark', round(be) from c
  union all select b, 'other', round(ot) from c
)
order by granularity_bucket asc
