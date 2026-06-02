-- pytorch/pytorch CI compute-HOURS split into the same 4 categories, per time bucket (exact, no rate est).
with c as (
  select DATE_TRUNC({granularity: String}, date) as b,
    sum(pr_hours) as pr, sum(main_hours) as mn, sum(nightly_hours) as ni, sum(bpo_hours) as bp
  from misc.unit_cost_daily
  where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
    and repo in {selectedRepos: Array(String)}
  group by b
)
select granularity_bucket, category, value from (
  select b as granularity_bucket, 'inside PR' as category, round(pr) as value from c
  union all select b, 'after merge', round(mn) from c
  union all select b, 'nightly (builds)', round(ni) from c
  union all select b, 'benchmark/periodic/other', round(bp) from c
)
order by granularity_bucket asc
