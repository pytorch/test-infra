-- pytorch/pytorch CI hours by category, per time bucket (for a stacked chart).
with c as (
  select DATE_TRUNC({granularity: String}, date) as b,
    sum(pr_hours) as pr, sum(main_hours) as mn, sum(nightly_hours) as ni,
    sum(periodic_hours) as pe, sum(benchmark_hours) as be, sum(other_hours) as ot
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
