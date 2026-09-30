-- Each category's SHARE (% of total $) per time bucket, for a 100%-stacked view.
with c as (
  select DATE_TRUNC({granularity: String}, date) as b,
    sum(pr_cost) pr, sum(main_cost) mn, sum(nightly_cost) ni,
    sum(periodic_cost) pe, sum(benchmark_cost) be, sum(other_cost) ot,
    nullIf(sum(total_cost), 0) tot
  from misc.unit_cost_daily
  where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
    and repo in {selectedRepos: Array(String)}
  group by b
)
select granularity_bucket, category, value from (
  select b as granularity_bucket, 'inside PR' as category, round(100*pr/tot,1) as value from c
  union all select b, 'after merge', round(100*mn/tot,1) from c
  union all select b, 'nightly (builds)', round(100*ni/tot,1) from c
  union all select b, 'periodic', round(100*pe/tot,1) from c
  union all select b, 'benchmark', round(100*be/tot,1) from c
  union all select b, 'other', round(100*ot/tot,1) from c
)
order by granularity_bucket asc
